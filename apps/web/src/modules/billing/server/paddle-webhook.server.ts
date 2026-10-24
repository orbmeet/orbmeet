import { createDb, type Database } from "@orbmeet/db";
import { organizationMembers, organizations, users } from "@orbmeet/db/schema";
import { and, count, eq, isNull, lt, or, sql } from "drizzle-orm";
import { getOptionalEnv } from "@/platform/runtime/server-runtime.server";
import {
  cancelSubscription,
  removeScheduledChange,
  getSubscription,
  PaddleApiError,
  updateSubscriptionQuantity,
  verifyPaddleWebhookSignature,
  type PaddleSubscription,
} from "@/modules/billing/server/paddle";
import { getRunChanges } from "@/platform/database/db-utils";
import { logError, logWarn } from "@/lib/logger";
import {
  parsePaddleWebhookEvent,
  resolvePaddleSubscriptionState,
  type ParsedPaddleEvent,
} from "@/modules/billing/server/paddle-subscription";
import { RequestBodyTooLargeError, readRequestBodyText } from "@/platform/http/request-body";
import {
  markWebhookReceiptProcessed,
  releaseWebhookReceipt,
  reserveWebhookReceipt,
} from "@/platform/http/webhooks/receipts";
import { configuredPaddlePriceId } from "@/modules/billing/server/paddle-config";
import { resolveDuplicateSubscription } from "@/modules/billing/server/duplicate-subscription";
import { enforceWebhookPreAuthRateLimit, rateLimitErrorResponse } from "@/platform/http/rate-limit.server";
import { runSerially } from "@/app/serial/serial";

const MAX_PADDLE_WEBHOOK_BODY_BYTES = 1024 * 1024;

/**
 * Stable dedup id for a Paddle event. Prefers Paddle's `event_id`; falls back
 * to a hash of the raw body so a redelivery still dedups when the field is
 * absent.
 */
async function derivePaddleEventId(event: ParsedPaddleEvent, body: string): Promise<string> {
  if (event.eventId?.trim()) return event.eventId;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
  return `content-${hex}`;
}

/**
 * Paddle webhook receiver: pre-auth rate limit, body cap, signature check,
 * then `handlePaddleEvent` behind a dedup/lease receipt.
 */
export async function handlePaddleWebhookRequest(request: Request): Promise<Response> {
  const env = await getOptionalEnv();
  if (!env?.PADDLE_WEBHOOK_SECRET) return new Response("Service unavailable", { status: 503 });
  try {
    await enforceWebhookPreAuthRateLimit(env, "paddle");
  } catch (error) {
    return rateLimitErrorResponse(error, "paddle-webhook-pre-auth");
  }

  let body: string;
  try {
    body = await readRequestBodyText(request, MAX_PADDLE_WEBHOOK_BODY_BYTES);
  } catch (err) {
    if (err instanceof RequestBodyTooLargeError) {
      return new Response("Payload too large", { status: 413 });
    }
    throw err;
  }
  const signature = request.headers.get("Paddle-Signature") ?? "";

  const valid = await verifyPaddleWebhookSignature(
    body,
    signature,
    env.PADDLE_WEBHOOK_SECRET,
  ).catch(() => false);
  if (!valid) {
    logWarn("[paddle-webhook] Invalid signature");
    return new Response("Unauthorized", { status: 401 });
  }

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(body) as unknown;
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }
  const event = parsePaddleWebhookEvent(parsedBody);
  if (!event) return new Response("Invalid Paddle event", { status: 400 });

  // Process synchronously behind a dedup/lease receipt: returning 500 on
  // failure lets Paddle redeliver (at-least-once), while the receipt makes
  // reprocessing a no-op (exactly-once effect). A fire-and-forget
  // waitUntil here would be at-most-once — a transient D1 error could
  // silently drop a subscription.created and leave a payer un-upgraded.
  const db = createDb(env.DB);
  const reservation = await reserveWebhookReceipt(db, {
    provider: "paddle",
    eventId: await derivePaddleEventId(event, body),
    eventType: event.eventType,
    eventCreatedAt: event.occurredAt ? new Date(event.occurredAt) : null,
  });
  if (reservation.status === "processed") {
    return new Response("OK", { status: 200 });
  }
  if (reservation.status === "in_progress") {
    return new Response("Webhook processing in progress", {
      status: 503,
      headers: { "Retry-After": String(reservation.retryAfterSeconds) },
    });
  }
  const claim = {
    receiptId: reservation.receiptId,
    leaseExpiresAt: reservation.leaseExpiresAt,
    attemptCount: reservation.attemptCount,
    ownerToken: reservation.ownerToken,
  };

  try {
    await handlePaddleEvent(db, event, env);
    if (!(await markWebhookReceiptProcessed(db, claim))) {
      throw new Error("Paddle webhook receipt lease expired before completion");
    }
  } catch (err) {
    logError("[paddle-webhook] Unhandled error:", err);
    await releaseWebhookReceipt(db, claim).catch((releaseErr) => {
      logError("[paddle-webhook] Failed to release failed webhook receipt:", releaseErr);
    });
    return new Response("Webhook processing failed", { status: 500 });
  }

  return new Response("OK", { status: 200 });
}

export async function handlePaddleEvent(
  db: Database,
  event: ParsedPaddleEvent,
  env: Env,
): Promise<void> {
  if (event.kind === "ignored") return;
  if (event.kind === "adjustment") {
    await handlePaddleAdjustment(event, env);
    return;
  }
  const owner = await db.query.users.findFirst({
    where:
      event.kind === "subscription-upsert"
        ? { paddleCustomerId: event.data.customer_id }
        : { paddleSubscriptionId: event.data.id },
    columns: { id: true },
  });
  // A cancellation can arrive for a subscription no user row still points at
  // (an erased account, an ownership transfer). The organizations row can
  // outlive that link, so find it directly: an event for an Organization's
  // subscription is applied in its serial scope, with every other change to
  // its seats.
  const organization = owner
    ? await db.query.organizations.findFirst({
        where: { ownerId: owner.id },
        columns: { id: true },
      })
    : event.kind === "subscription-canceled"
      ? await db.query.organizations.findFirst({
          where: { paddleSubscriptionId: event.data.id },
          columns: { id: true },
        })
      : undefined;
  if (organization) {
    await runSerially(env, { kind: "applyOrganizationPaddleEvent", organizationId: organization.id, event });
  } else {
    await applyPaddleEvent(db, event, env);
  }
}

/**
 * A refund or chargeback does not cancel a Paddle subscription on its own, so
 * without this a customer who paid and then got their money back kept a paid
 * plan until someone cancelled by hand — and each renewal repeated the cycle.
 *
 * The money-is-gone cases end the contract: an actual `chargeback` (the bank has
 * already reversed the charge), and a full, approved `refund`. Everything else a
 * Paddle adjustment can be — a partial or tax or proration refund, a credit, a
 * chargeback *warning* that may never become a chargeback, or any of the reversal
 * actions — leaves the subscription alone.
 *
 * Ending it is done by cancelling at Paddle immediately rather than writing the
 * downgrade here: Paddle then emits `subscription.canceled`, which the tested
 * path below turns into the entitlement change, and reconciliation sees the
 * canceled status as a backstop. The cancel is idempotent — an already-gone or
 * already-canceled subscription is a no-op — and any transient failure throws so
 * the webhook is redelivered.
 */
async function handlePaddleAdjustment(
  event: Extract<ParsedPaddleEvent, { kind: "adjustment" }>,
  env: Env,
): Promise<void> {
  const { action, type, status, subscription_id: subscriptionId, id: adjustmentId } = event.data;
  const endsEntitlement =
    action === "chargeback" ||
    (action === "refund" && type === "full" && status === "approved");
  if (!endsEntitlement) return;
  if (!subscriptionId) {
    // A one-off transaction refund with no subscription behind it maps to no
    // durable plan, so there is nothing to end.
    logWarn("[paddle-webhook] Entitlement-ending adjustment carries no subscription", {
      adjustmentId,
      action,
    });
    return;
  }
  if (!env.PADDLE_API_KEY) throw new Error("Paddle API key is unavailable");

  let current: PaddleSubscription;
  try {
    current = await getSubscription(env.PADDLE_API_KEY, subscriptionId);
  } catch (err) {
    // 404 is an answer: the subscription is already gone. Anything else is
    // unknown, so rethrow and let Paddle redeliver.
    if (err instanceof PaddleApiError && err.status === 404) {
      logWarn("[paddle-webhook] Refund/chargeback for a subscription that no longer exists", {
        adjustmentId,
        subscriptionId,
        action,
      });
      return;
    }
    throw err;
  }
  if (current.status === "canceled") return;
  // A cancellation scheduled for the period's end still leaves the refunded
  // period paid for; the money is gone now, so the access ends now. Paddle
  // locks a subscription with a pending change, so that change goes first.
  if (current.scheduled_change) await removeScheduledChange(env.PADDLE_API_KEY, subscriptionId);
  await cancelSubscription(env.PADDLE_API_KEY, subscriptionId, "immediately");
  logWarn("[paddle-webhook] Canceled a subscription after a refund or chargeback", {
    adjustmentId,
    subscriptionId,
    action,
    type,
  });
}

export async function applyPaddleEvent(
  db: Database,
  event: ParsedPaddleEvent,
  env: Env,
): Promise<void> {
  const { eventType, occurredAt } = event;
  const eventTime = occurredAt ? new Date(occurredAt) : new Date();
  const appliedAt = new Date();

  if (event.kind === "subscription-upsert") {
    const { id: subscriptionId, customer_id: customerId, status, items } = event.data;
    const resolved = resolvePaddleSubscriptionState({ status, items }, env);
    if (!resolved.resolved) {
      if (resolved.reason === "unknown-status") {
        // Paddle reported a status this build does not model. Retrying cannot
        // fix that, so acknowledge the delivery and leave the projection as it
        // is rather than retry until Paddle gives up. Reconciliation re-reads
        // this subscription on its next pass.
        logError("[paddle-webhook] Unknown Paddle subscription status; projection left unchanged", {
          customerId,
          subscriptionId,
          status,
        });
        return;
      }
      logError("[paddle-webhook] Subscription price catalog did not resolve uniquely", {
        customerId,
        subscriptionId,
        priceIds: items.map(({ price }) => price.id),
      });
      throw new Error("Paddle subscription price catalog is unresolved");
    }
    const managedSubscriptionId = resolved.status === "canceled" ? null : subscriptionId;

    const userRow = await db.query.users.findFirst({
      where: { paddleCustomerId: customerId },
      columns: {
        id: true,
        paddleSubscriptionId: true,
        subscriptionUpdatedAt: true,
      },
    });
    if (!userRow) {
      // No user row projects this customer any more. A silent ack is not
      // enough: an acknowledged event is never redelivered, so a live
      // subscription whose account has been erased would keep billing forever
      // with nothing in-product able to reach it. The account is gone; there is
      // no one left to bill. Cancel the contract at Paddle before
      // acknowledging, idempotently (a re-observe of an already-canceled
      // subscription is a no-op), and let any failure release the receipt for
      // redelivery.
      const organization = await db.query.organizations.findFirst({
        where: {
          RAW: (row) =>
            or(eq(row.paddleCustomerId, customerId), eq(row.paddleSubscriptionId, subscriptionId))!,
        },
        columns: { id: true },
      });
      if (organization) {
        // An ownership transfer parks a subscription on the organizations row
        // with no user projection behind it. That contract is alive on purpose.
        logWarn(
          "[paddle-webhook] Subscription event for a customer held by an organization; left untouched",
          { customerId, subscriptionId, organizationId: organization.id },
        );
        return;
      }
      if (!env.PADDLE_API_KEY) throw new Error("Paddle API key is unavailable");
      let current: PaddleSubscription;
      try {
        current = await getSubscription(env.PADDLE_API_KEY, subscriptionId);
      } catch (err) {
        // 404 is an answer: the subscription is already gone, nothing to
        // cancel. Any other failure is unknown — rethrow so the event stays
        // unacknowledged and Paddle redelivers.
        if (err instanceof PaddleApiError && err.status === 404) {
          logWarn(
            "[paddle-webhook] Subscription for an unknown customer no longer exists at Paddle",
            { customerId, subscriptionId },
          );
          return;
        }
        throw err;
      }
      // Identity fence, the same one the deletion preflight applies before it
      // cancels anything: the event names a customer, but the *contract* about
      // to be destroyed is whatever Paddle returns for the event's
      // subscription id. Absence of a local row is evidence about our
      // projection, never about who owns this subscription, so confirm the two
      // agree before acting. A disagreement means the premise of this whole
      // branch is false — cancel nothing, and ack, because a redelivery of the
      // same mismatched event would only reach the same conclusion.
      if (current.id !== subscriptionId || current.customer_id !== customerId) {
        logError(
          "[paddle-webhook] Subscription identity does not match the event; left untouched",
          {
            customerId,
            subscriptionId,
            resolvedSubscriptionId: current.id,
            resolvedCustomerId: current.customer_id,
          },
        );
        return;
      }
      if (current.status === "canceled" || current.scheduled_change?.action === "cancel") {
        logWarn("[paddle-webhook] Subscription for an unknown customer is already canceled", {
          customerId,
          subscriptionId,
          status: current.status,
        });
        return;
      }
      await cancelSubscription(env.PADDLE_API_KEY, subscriptionId, "immediately");
      logWarn("[paddle-webhook] Canceled a subscription whose customer no longer has an account", {
        customerId,
        subscriptionId,
        status: current.status,
      });
      return;
    }

    // A second subscription for a customer who already has one is a billing
    // fault worth cancelling — but "already has one" cannot be read off the
    // local projection alone, which is the very thing a webhook exists to
    // repair. A stale row (an abandoned checkout, a cancellation Paddle has
    // already applied, an id left behind next to a canceled status) would make
    // this branch cancel the customer's real, current subscription. Ask Paddle
    // what the stored id actually is before destroying anything on its behalf.
    //
    // A stored id of null leaves nothing to protect, whatever the stored status
    // says, so the incoming subscription is simply adopted below.
    const duplicate = await resolveDuplicateSubscription({
      storedSubscriptionId: userRow.paddleSubscriptionId,
      incomingSubscriptionId: subscriptionId,
      lookupStatus: async (lookupSubscriptionId) => {
        if (!env.PADDLE_API_KEY) throw new Error("Paddle API key is unavailable");
        try {
          return (await getSubscription(env.PADDLE_API_KEY, lookupSubscriptionId)).status;
        } catch (err) {
          // A 404 is an answer: Paddle has no such subscription, so the stored
          // id is a leftover. Everything else — network, 5xx, auth — is
          // *unknown*, and acting on an unknown is precisely the mistake being
          // fixed here. Rethrow so the webhook is retried instead.
          if (err instanceof PaddleApiError && err.status === 404) return null;
          throw err;
        }
      },
    });

    if (duplicate.action !== "adopt") {
      // The stored subscription is confirmed live, so this one is the duplicate.
      // Its local projection is left untouched in both branches.
      if (duplicate.action === "cancel-incoming") {
        if (!env.PADDLE_API_KEY) throw new Error("Paddle API key is unavailable");
        await cancelSubscription(env.PADDLE_API_KEY, subscriptionId, "immediately");
      }
      logWarn(
        duplicate.action === "cancel-incoming"
          ? "[paddle-webhook] Canceled duplicate subscription"
          : "[paddle-webhook] Ignored an already-canceled duplicate subscription",
        { customerId, subscriptionId, retainedSubscriptionId: duplicate.retainedSubscriptionId },
      );
      return;
    }
    // Guards every write below. It cannot also guard the duplicate branch
    // above: `subscriptionUpdatedAt` describes the *stored* subscription, so
    // comparing a different subscription's event against it would suppress
    // legitimate duplicate cleanup. That branch is protected instead by reading
    // both subscriptions' current status from Paddle rather than the event's.
    if (userRow.subscriptionUpdatedAt && eventTime <= new Date(userRow.subscriptionUpdatedAt)) {
      logWarn("[paddle-webhook] Stale event ignored", {
        eventType,
        occurredAt,
        subscriptionUpdatedAt: userRow.subscriptionUpdatedAt,
      });
      return;
    }

    if (userRow.paddleSubscriptionId && userRow.paddleSubscriptionId !== subscriptionId) {
      logWarn(
        "[paddle-webhook] Stored subscription is not live at Paddle; adopting the incoming one",
        {
          customerId,
          subscriptionId,
          storedSubscriptionId: userRow.paddleSubscriptionId,
          storedStatus: duplicate.storedStatus,
        },
      );
    }

    let organizationLicenseLimit: number | undefined;
    if (resolved.plan === "organization") {
      const organizationPriceId = configuredPaddlePriceId(env.PADDLE_PRICE_ID_ORG_SEAT);
      const paidQuantity = items.find(({ price }) => price.id === organizationPriceId)?.quantity;
      if (!Number.isSafeInteger(paidQuantity) || (paidQuantity ?? 0) < 1) {
        throw new Error("Organization subscription has an invalid seat quantity");
      }
      const organization = await db.query.organizations.findFirst({
        where: { ownerId: userRow.id },
        columns: { id: true },
      });
      const [{ value: memberCount = 0 } = {}] = organization
        ? await db
            .select({ value: count() })
            .from(organizationMembers)
            .where(eq(organizationMembers.organizationId, organization.id))
        : [];
      const requiredQuantity = Math.max(1, memberCount);
      if (paidQuantity! < requiredQuantity) {
        if (!env.PADDLE_API_KEY || !organizationPriceId) {
          throw new Error("Paddle organization seat reconciliation is unavailable");
        }
        await updateSubscriptionQuantity(
          env.PADDLE_API_KEY,
          subscriptionId,
          organizationPriceId,
          requiredQuantity,
        );
        logWarn("[paddle-webhook] Corrected under-quantity subscription before entitlement", {
          customerId,
          subscriptionId,
          paidQuantity,
          requiredQuantity,
        });
        return;
      }
      organizationLicenseLimit = paidQuantity;
    }

    const result = await db.batch([
      db
        .update(users)
        .set({
          paddleCustomerId: customerId,
          paddleSubscriptionId: managedSubscriptionId,
          subscriptionStatus: resolved.status,
          plan: resolved.plan,
          subscriptionUpdatedAt: eventTime,
          updatedAt: appliedAt,
        })
        .where(
          and(
            eq(users.id, userRow.id),
            userRow.paddleSubscriptionId === null
              ? isNull(users.paddleSubscriptionId)
              : eq(users.paddleSubscriptionId, userRow.paddleSubscriptionId),
            or(isNull(users.subscriptionUpdatedAt), lt(users.subscriptionUpdatedAt, eventTime)),
          ),
        ),
      db
        .update(organizations)
        .set({
          paddleCustomerId: customerId,
          paddleSubscriptionId: managedSubscriptionId,
          subscriptionStatus: resolved.status,
          plan: resolved.plan,
          ...(organizationLicenseLimit !== undefined
            ? { licenseLimit: organizationLicenseLimit }
            : { licenseLimit: 1 }),
          subscriptionUpdatedAt: eventTime,
          updatedAt: appliedAt,
        })
        .where(
          and(
            sql`exists (select 1 from ${users} adopted where adopted.id = ${userRow.id}
              and adopted.paddle_subscription_id IS ${managedSubscriptionId}
              and adopted.subscription_updated_at = ${eventTime.getTime()})`,
            resolved.plan === "organization"
              ? eq(organizations.ownerId, userRow.id)
              : eq(organizations.paddleSubscriptionId, subscriptionId),
            or(
              isNull(organizations.subscriptionUpdatedAt),
              lt(organizations.subscriptionUpdatedAt, eventTime),
            ),
          ),
        ),
    ]);
    if (getRunChanges(result[0]) === 0) {
      // Never acknowledge a CAS loser. Retried delivery either observes
      // an already-applied event or cancels the distinct subscription that lost.
      throw new Error("Subscription projection changed concurrently; retry event");
    }
    return;
  }

  if (event.kind === "subscription-canceled") {
    const subscriptionId = event.data.id;

    // This event means cancellation has taken effect. A scheduled request
    // remains active and arrives as subscription.updated until period end.
    const userRow = await db.query.users.findFirst({
      where: { paddleSubscriptionId: subscriptionId },
      columns: { id: true, subscriptionUpdatedAt: true },
    });

    if (userRow?.subscriptionUpdatedAt && eventTime <= new Date(userRow.subscriptionUpdatedAt)) {
      logWarn("[paddle-webhook] Stale event ignored", {
        eventType,
        occurredAt,
        subscriptionUpdatedAt: userRow.subscriptionUpdatedAt,
      });
      return;
    }

    const downgradeOrganization = () =>
      db
        .update(organizations)
        .set({
          plan: "free",
          licenseLimit: 1,
          subscriptionStatus: "canceled",
          paddleSubscriptionId: null,
          subscriptionUpdatedAt: eventTime,
          updatedAt: appliedAt,
        })
        .where(
          and(
            eq(organizations.paddleSubscriptionId, subscriptionId),
            or(
              isNull(organizations.subscriptionUpdatedAt),
              lt(organizations.subscriptionUpdatedAt, eventTime),
            ),
          ),
        );

    // No user row still points at this subscription — an erased account, or an
    // ownership transfer that moved the link. The organizations row can outlive
    // that and would otherwise keep a paid plan and its seat ceiling forever.
    // A cancellation only ever removes entitlements, so applying it alone is
    // always safe; there is simply no user projection left to write.
    if (!userRow) {
      const orphaned = await downgradeOrganization();
      if (getRunChanges(orphaned) > 0) {
        logWarn(
          "[paddle-webhook] Downgraded an organization whose owner no longer holds the subscription",
          {
            eventType,
            subscriptionId,
          },
        );
      }
      return;
    }

    {
      const result = await db.batch([
        db
          .update(users)
          .set({
            plan: "free",
            subscriptionStatus: "canceled",
            paddleSubscriptionId: null,
            subscriptionUpdatedAt: eventTime,
            updatedAt: appliedAt,
          })
          .where(
            and(
              eq(users.id, userRow.id),
              eq(users.paddleSubscriptionId, subscriptionId),
              or(isNull(users.subscriptionUpdatedAt), lt(users.subscriptionUpdatedAt, eventTime)),
            ),
          ),
        downgradeOrganization(),
      ]);
      if (getRunChanges(result[0]) === 0) {
        logWarn("[paddle-webhook] Concurrent stale event ignored", { eventType, occurredAt });
      }
    }
    return;
  }
}
