import "@tanstack/react-start/server-only";

import type { Database } from "@orbmeet/db";
import {
  organizationMembers,
  organizationOwnershipTransfers,
  organizations,
  users,
} from "@orbmeet/db/schema";
import { Errors } from "@/lib/app-errors";
import { hasSubscriptionEntitlements } from "@/modules/billing/contract/subscription";
import { and, count, eq, gt, sql } from "drizzle-orm";
import { getRunChanges, withD1Retry } from "@/platform/database/db-utils";
import {
  getSubscription,
  updateSubscriptionQuantity,
  type PaddleSubscription,
} from "@/modules/billing/server/paddle";
import { configuredPaddlePriceId } from "@/modules/billing/server/paddle-config";
import { resolvePaddleSubscriptionState } from "./paddle-subscription";
import { logError } from "@/lib/logger";

interface QuantityState {
  subscriptionId: string;
  original: number;
  desired: number;
}

function subscriptionQuantity(
  subscription: PaddleSubscription,
  priceId: string,
): number | null {
  const quantity = subscription.items.find(({ price }) => price.id === priceId)?.quantity;
  return Number.isSafeInteger(quantity) && quantity! > 0 ? quantity! : null;
}

/**
 * Undo the quantity changes this attempt made, and nothing else. Only the
 * changes it attempted are considered (one whose request failed may still
 * have landed), and each only while Paddle still shows the quantity this
 * attempt set: any other value is someone else's later change, which a
 * restore would overwrite.
 */
async function restoreQuantities(
  apiKey: string,
  priceId: string,
  attempted: readonly QuantityState[],
): Promise<void> {
  const results = await Promise.allSettled(
    attempted.map(async ({ subscriptionId, original, desired }) => {
      const current = subscriptionQuantity(await getSubscription(apiKey, subscriptionId), priceId);
      if (current !== desired) return;
      await updateSubscriptionQuantity(apiKey, subscriptionId, priceId, original);
    }),
  );
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : []
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, "Organization billing rollback failed");
  }
}

type TransferCommitProbe =
  | { kind: "committed" }
  | { kind: "absent" }
  | { kind: "unknown" };

/**
 * Whether the guarded ownership UPDATE committed — this attempt's, or a prior
 * one that lost its response before the Paddle quantities could be restored.
 *
 * A failed read must stay distinct from a read that found nothing. Treating
 * "unknown" as "not committed" would restore both subscriptions to their
 * original quantities even though the swap may have gone through, leaving the
 * new owner's members without paid seats. On unknown nothing is compensated.
 */
async function hasCommittedTransfer(
  db: Database,
  organizationId: string,
  newOwnerUserId: string,
  newSubscriptionId: string,
): Promise<TransferCommitProbe> {
  try {
    const current = await db.query.organizations.findFirst({
      where: { id: organizationId },
      columns: { ownerId: true, paddleSubscriptionId: true },
    });
    return current?.ownerId === newOwnerUserId
      && current.paddleSubscriptionId === newSubscriptionId
      ? { kind: "committed" }
      : { kind: "absent" };
  } catch {
    return { kind: "unknown" };
  }
}

/**
 * Put back the quantities a transfer that did not commit changed, on proof
 * only. An unreadable outcome, or a restore Paddle refuses, is logged for an
 * operator instead: the raise-only reconciliation still keeps every
 * subscription at or above its members, so what is left is at most a seat
 * someone pays for without using. Never throws, so the transfer's own error
 * is what the caller sees.
 */
async function undoUncommittedTransfer(
  apiKey: string,
  priceId: string,
  attempted: readonly QuantityState[],
  commit: Exclude<TransferCommitProbe, { kind: "committed" }>,
  organizationId: string,
): Promise<void> {
  if (attempted.length === 0) return;
  if (commit.kind === "unknown") {
    logError("[billing] Transfer outcome unreadable; Paddle quantities left for an operator", {
      organizationId,
      attempted,
    });
    return;
  }
  try {
    await restoreQuantities(apiKey, priceId, attempted);
  } catch (error) {
    logError("[billing] Could not restore a failed transfer's Paddle quantities", {
      organizationId,
      attempted,
    }, error);
  }
}

/**
 * Swap an Organization's billing onto its new owner's subscription. Runs in
 * the Organization's serial scope (app/serial), after any other change
 * to its seats.
 */
export async function transferOrganizationBillingOwnership(
  db: Database,
  env: Env,
  input: {
    organizationId: string;
    currentOwnerUserId: string;
    newOwnerUserId: string;
    now?: Date;
  },
): Promise<boolean> {
  const acceptedAt = input.now ?? new Date();
  const organization = await db.query.organizations.findFirst({
    where: { id: input.organizationId },
    columns: {
      ownerId: true,
      paddleCustomerId: true,
      paddleSubscriptionId: true,
    },
  });
  const newOwner = await db.query.users.findFirst({
    where: { id: input.newOwnerUserId },
    columns: {
      plan: true,
      paddleCustomerId: true,
      paddleSubscriptionId: true,
      subscriptionStatus: true,
      subscriptionUpdatedAt: true,
      deletionStartedAt: true,
    },
  });
  if (!organization || !newOwner) return false;
  // A prior attempt may have committed the ownership swap but lost its
  // response before the nomination cleanup. Treat that state as success so
  // the accept endpoint can retry the cleanup idempotently.
  if (
    organization.ownerId === input.newOwnerUserId &&
    newOwner.paddleSubscriptionId !== null &&
    organization.paddleSubscriptionId === newOwner.paddleSubscriptionId
  ) {
    return true;
  }
  if (organization.ownerId !== input.currentOwnerUserId) return false;
  if (
    newOwner.deletionStartedAt !== null
    || newOwner.plan !== "organization"
    || !hasSubscriptionEntitlements(newOwner.subscriptionStatus)
    || !newOwner.paddleCustomerId
    || !newOwner.paddleSubscriptionId
    || !organization.paddleSubscriptionId
    || organization.paddleSubscriptionId === newOwner.paddleSubscriptionId
  ) {
    return false;
  }

  const [
    membership,
    otherOrganization,
    pendingTransfer,
    [{ value: memberCount } = { value: 0 }],
  ] =
    await Promise.all([
      db.query.organizationMembers.findFirst({
        where: {
          RAW: (row) => and(
            eq(row.organizationId, input.organizationId),
            eq(row.userId, input.newOwnerUserId),
          )!,
        },
        columns: { id: true },
      }),
      db.query.organizations.findFirst({
        where: { ownerId: input.newOwnerUserId },
        columns: { id: true },
      }),
      db.query.organizationOwnershipTransfers.findFirst({
        where: {
          RAW: (transfer) => and(
            eq(transfer.organizationId, input.organizationId),
            eq(transfer.requestedByUserId, input.currentOwnerUserId),
            eq(transfer.proposedOwnerUserId, input.newOwnerUserId),
            gt(transfer.expiresAt, acceptedAt),
          )!,
        },
        columns: { organizationId: true },
      }),
      db.select({ value: count() })
        .from(organizationMembers)
        .where(eq(organizationMembers.organizationId, input.organizationId)),
    ]);
  if (!membership || otherOrganization || !pendingTransfer || memberCount < 1) return false;

  const priceId = configuredPaddlePriceId(env.PADDLE_PRICE_ID_ORG_SEAT);
  if (!env.PADDLE_API_KEY || !priceId) {
    throw Errors.CONFIG_ERROR("Organization billing is not configured.");
  }

  const [oldSubscription, newSubscription] = await Promise.all([
    getSubscription(env.PADDLE_API_KEY, organization.paddleSubscriptionId),
    getSubscription(env.PADDLE_API_KEY, newOwner.paddleSubscriptionId),
  ]);
  const oldState = resolvePaddleSubscriptionState(oldSubscription, env);
  const newState = resolvePaddleSubscriptionState(newSubscription, env);
  const oldQuantity = subscriptionQuantity(oldSubscription, priceId);
  const newQuantity = subscriptionQuantity(newSubscription, priceId);
  if (
    oldState.plan !== "organization"
    || newState.plan !== "organization"
    || !hasSubscriptionEntitlements(oldState.status)
    || !hasSubscriptionEntitlements(newState.status)
    || oldQuantity === null
    || newQuantity === null
    || oldSubscription.customer_id !== organization.paddleCustomerId
    || newSubscription.customer_id !== newOwner.paddleCustomerId
  ) {
    throw Errors.VALIDATION(
      "Both owners must have an active Organization subscription with valid seat billing.",
    );
  }

  // The incoming subscription has to cover the organization's members, and
  // that same quantity becomes the organization's license ceiling in the
  // guarded update below — the ceiling must describe what is actually paid
  // for, never the previous owner's leftover headroom.
  const incomingQuantity = Math.max(1, memberCount);
  const quantities: QuantityState[] = [
    {
      subscriptionId: oldSubscription.id,
      original: oldQuantity,
      desired: 1,
    },
    {
      subscriptionId: newSubscription.id,
      original: newQuantity,
      desired: incomingQuantity,
    },
  ];

  // What this attempt asked Paddle to change, so a rollback undoes exactly
  // that. Pushed before each request: one that fails may still have landed.
  const attempted: QuantityState[] = [];
  const apiKey = env.PADDLE_API_KEY;

  try {
    for (const quantity of quantities) {
      if (quantity.original !== quantity.desired) {
        attempted.push(quantity);
        await updateSubscriptionQuantity(
          apiKey,
          quantity.subscriptionId,
          priceId,
          quantity.desired,
        );
      }
    }

    const now = acceptedAt;
    // license_limit rides the same guarded statement, after the Paddle
    // quantity change above has succeeded: it must equal the quantity
    // actually applied to the incoming subscription. Writing it any earlier
    // — or leaving it stale — lets invitations ride headroom the new
    // subscription never paid for until a webhook or the daily
    // reconciliation happened to correct the projection.
    const result = await withD1Retry(() => db.run(sql`
      update ${organizations}
      set
        owner_id = ${input.newOwnerUserId},
        paddle_customer_id = ${newOwner.paddleCustomerId},
        paddle_subscription_id = ${newOwner.paddleSubscriptionId},
        subscription_status = ${newOwner.subscriptionStatus},
        subscription_updated_at = ${newOwner.subscriptionUpdatedAt
          ? newOwner.subscriptionUpdatedAt.getTime()
          : null},
        license_limit = ${incomingQuantity},
        updated_at = ${Math.floor(now.getTime() / 1000)}
      where ${organizations.id} = ${input.organizationId}
        and ${organizations.ownerId} = ${input.currentOwnerUserId}
        and exists (
          select 1 from ${organizationMembers}
          where ${organizationMembers.organizationId} = ${input.organizationId}
            and ${organizationMembers.userId} = ${input.newOwnerUserId}
        )
        and exists (
          select 1 from ${users}
          where ${users.id} = ${input.newOwnerUserId}
            and ${users.deletionStartedAt} is null
            and ${users.plan} = 'organization'
            and ${users.subscriptionStatus} in ('active', 'trialing')
            and ${users.paddleCustomerId} = ${newOwner.paddleCustomerId}
            and ${users.paddleSubscriptionId} = ${newOwner.paddleSubscriptionId}
        )
        and exists (
          select 1 from ${organizationOwnershipTransfers}
          where ${organizationOwnershipTransfers.organizationId} = ${input.organizationId}
            and ${organizationOwnershipTransfers.requestedByUserId} = ${input.currentOwnerUserId}
            and ${organizationOwnershipTransfers.proposedOwnerUserId} = ${input.newOwnerUserId}
            and ${organizationOwnershipTransfers.expiresAt} > ${Math.floor(now.getTime() / 1000)}
        )
        and not exists (
          select 1 from ${organizations} other
          where other.owner_id = ${input.newOwnerUserId}
            and other.id <> ${input.organizationId}
        )
    `), { idempotent: true });

    if (getRunChanges(result) > 0) {
      return true;
    }
    // The guarded update matched zero rows: either a precondition no longer
    // holds, or a prior attempt already committed the swap and lost its
    // response. Resolve which before compensating.
    const commit = await hasCommittedTransfer(
      db,
      input.organizationId,
      input.newOwnerUserId,
      newOwner.paddleSubscriptionId,
    );
    if (commit.kind === "committed") {
      return true;
    }
    await undoUncommittedTransfer(apiKey, priceId, attempted, commit, input.organizationId);
    return false;
  } catch (error) {
    const commit = await hasCommittedTransfer(
      db,
      input.organizationId,
      input.newOwnerUserId,
      newOwner.paddleSubscriptionId,
    );
    if (commit.kind === "committed") {
      return true;
    }
    await undoUncommittedTransfer(apiKey, priceId, attempted, commit, input.organizationId);
    throw error;
  }
}
