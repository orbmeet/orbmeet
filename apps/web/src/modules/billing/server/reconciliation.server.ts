import "@tanstack/react-start/server-only";

import { createDb, type Database } from "@orbmeet/db";
import { organizationMembers, organizations, users } from "@orbmeet/db/schema";
import { and, asc, count, eq, gt, isNotNull, isNull, lt, or } from "drizzle-orm";
import { getSubscription, updateSubscriptionQuantity } from "@/modules/billing/server/paddle";
import { withD1Retry } from "@/platform/database/db-utils";
import { readMaintenanceCursor, writeMaintenanceCursor } from "@/platform/database/maintenance-cursor";
import { resolvePaddleSubscriptionState, type PaddlePriceConfig } from "./paddle-subscription";
import { configuredPaddlePriceId } from "@/modules/billing/server/paddle-config";
import { logError } from "@/lib/logger";
import { runSerially } from "@/app/serial/serial";

type ReconciliationEnv = PaddlePriceConfig & { PADDLE_API_KEY?: string } & Pick<Env, "SERIAL_SCOPES">;

const RECONCILIATION_JOB = "paddle-subscriptions";
const RECONCILIATION_BATCH = 20;

export async function reconcilePaddleSubscriptions(
  db: Database,
  env: ReconciliationEnv,
  now = new Date(),
): Promise<number> {
  if (!env.PADDLE_API_KEY) return 0;
  const cursor = await readMaintenanceCursor(db, RECONCILIATION_JOB);
  const rows = await db
    .select({ id: users.id, subscriptionId: users.paddleSubscriptionId })
    .from(users)
    .where(
      and(
        isNotNull(users.paddleSubscriptionId),
        cursor ? gt(users.id, cursor) : undefined,
      ),
    )
    .orderBy(asc(users.id))
    .limit(RECONCILIATION_BATCH);

  const failures: unknown[] = [];
  for (const row of rows) {
    try {
      const subscriptionId = row.subscriptionId;
      if (!subscriptionId) continue;
      const ownedOrganization = await db.query.organizations.findFirst({
        where: { ownerId: row.id },
        columns: { id: true },
      });
      // An owner's seats are an Organization's: reconcile them in its serial
      // scope, with every other change to them.
      if (ownedOrganization) {
        await runSerially(env, {
          kind: "reconcileOrganizationOwner",
          organizationId: ownedOrganization.id,
          userId: row.id,
          subscriptionId,
          now: now.getTime(),
        });
      } else {
        await reconcileSubscriber(db, env, { userId: row.id, subscriptionId, organizationId: null }, now);
      }
    } catch (error) {
      failures.push(error);
    } finally {
      // Progress is durable per row, including poison rows. Once the scan wraps,
      // failed rows become eligible again without blocking every payer behind
      // them during this pass.
      await writeMaintenanceCursor(db, RECONCILIATION_JOB, row.id);
    }
  }

  const nextCursorId = rows.length === RECONCILIATION_BATCH ? rows[rows.length - 1].id : null;
  await writeMaintenanceCursor(db, RECONCILIATION_JOB, nextCursorId);
  if (failures.length > 0) {
    throw new AggregateError(failures, "Paddle reconciliation completed with row failures");
  }
  return rows.length;
}

/**
 * Bring one subscriber's projection — and the Organization they own, if any —
 * to what Paddle holds. An owner's runs in the Organization's serial scope.
 */
export async function reconcileSubscriber(
  db: Database,
  env: PaddlePriceConfig & { PADDLE_API_KEY?: string },
  subscriber: { userId: string; subscriptionId: string; organizationId: string | null },
  now: Date,
): Promise<null> {
  const apiKey = env.PADDLE_API_KEY;
  if (!apiKey) return null;
  const { userId, subscriptionId, organizationId } = subscriber;
  const organizationPriceId = configuredPaddlePriceId(env.PADDLE_PRICE_ID_ORG_SEAT);
  const subscription = await getSubscription(apiKey, subscriptionId);
  if (subscription.id !== subscriptionId) {
    throw new Error(`Paddle returned the wrong subscription for ${userId}`);
  }
  const sourceUpdatedAt = new Date(subscription.updated_at);
  if (!Number.isFinite(sourceUpdatedAt.getTime())) {
    throw new Error(`Paddle returned an invalid updated_at for ${userId}`);
  }
  const state = resolvePaddleSubscriptionState(subscription, env);
  if (!state.resolved) {
    // Neither an unknown status nor an unresolved catalog says anything
    // about what this customer is entitled to, so skip the row rather than
    // write a guess. The next pass re-reads it.
    logError(
      state.reason === "unknown-status"
        ? "[paddle-reconciliation] Unknown Paddle subscription status; row left unchanged"
        : "[paddle-reconciliation] Subscription price catalog did not resolve uniquely",
      {
        subscriptionId,
        status: subscription.status,
        priceIds: subscription.items.map(({ price }) => price.id),
      },
    );
    return null;
  }
  const managedSubscriptionId = state.status === "canceled" ? null : subscriptionId;
  // A user-level Organization subscription has no managed seat quantity
  // until that user actually owns an Organization. In particular, an
  // accepted ownership transfer raises the incoming subscription before
  // the owner row changes; reconciliation must not reset it in that window.
  let licenseLimit: number | undefined;
  if (state.plan === "organization" && organizationPriceId && organizationId) {
    const [{ value: memberCount } = { value: 0 }] = await db
      .select({ value: count() })
      .from(organizationMembers)
      .where(eq(organizationMembers.organizationId, organizationId));
    const currentQuantity = subscription.items.find(
      ({ price }) => price.id === organizationPriceId,
    )?.quantity;
    const expectedQuantity = Math.max(1, memberCount, currentQuantity ?? 0);
    if (currentQuantity !== undefined) {
      if (currentQuantity !== expectedQuantity) {
        await updateSubscriptionQuantity(apiKey, subscriptionId, organizationPriceId, expectedQuantity);
      }
      // Keep the license ceiling at the seat quantity the customer pays
      // for, as the webhook handler does — an Organization created after
      // subscribing (or one whose event was missed) otherwise stays at its
      // creation default forever.
      licenseLimit = expectedQuantity;
    }
  }
  await withD1Retry(
    () =>
      db.batch([
        db
          .update(users)
          .set({
            plan: state.plan,
            paddleCustomerId: subscription.customer_id,
            paddleSubscriptionId: managedSubscriptionId,
            subscriptionStatus: state.status,
            subscriptionUpdatedAt: sourceUpdatedAt,
            updatedAt: now,
          })
          .where(
            and(
              eq(users.id, userId),
              eq(users.paddleSubscriptionId, subscriptionId),
              or(
                isNull(users.subscriptionUpdatedAt),
                lt(users.subscriptionUpdatedAt, sourceUpdatedAt),
              ),
            ),
          ),
        db
          .update(organizations)
          .set({
            plan: state.plan,
            paddleCustomerId: subscription.customer_id,
            paddleSubscriptionId: managedSubscriptionId,
            subscriptionStatus: state.status,
            ...(licenseLimit !== undefined
              ? { licenseLimit }
              : state.plan !== "organization"
                ? { licenseLimit: 1 }
                : {}),
            subscriptionUpdatedAt: sourceUpdatedAt,
            updatedAt: now,
          })
          .where(
            and(
              eq(organizations.ownerId, userId),
              eq(organizations.paddleSubscriptionId, subscriptionId),
              or(
                isNull(organizations.subscriptionUpdatedAt),
                lt(organizations.subscriptionUpdatedAt, sourceUpdatedAt),
              ),
            ),
          ),
      ]),
    { idempotent: true },
  );
  return null;
}

export async function runPaddleSubscriptionReconciliation(env: Env, now = new Date()) {
  return reconcilePaddleSubscriptions(createDb(env.DB), env, now);
}
