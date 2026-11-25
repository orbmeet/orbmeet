import "@tanstack/react-start/server-only";

import type { Database } from "@orbmeet/db";
import { billingSubscriptions, organizations, users } from "@orbmeet/db/schema";
import { and, desc, eq, ne, sql } from "drizzle-orm";
import { logError, logWarn } from "@/lib/logger";
import { ENDED_SUBSCRIPTION_STATUS } from "@/modules/billing/contract/subscription";
import {
  planForCustomer,
  type BillingCustomer,
  type PaidSubscriptionTier,
  type SubscriptionStatus,
} from "@/modules/billing/contract/types";
import { getRunChanges } from "@/platform/database/db-utils";
import { parseCustomerExternalId } from "./customer-ids";
import { polarProductIdForPlan, type PolarCatalogConfig } from "./polar-config";
import { subscriptionVersion, type PolarSubscription } from "./polar-schema";

/**
 * The one writer of `billing_subscriptions`: a projection of Polar, nothing
 * more. Webhooks, the daily reconciliation and seat changes all hand it the
 * subscription Polar returned, and it stores that snapshot if it is newer than
 * the stored one. It never calls Polar and never acts on what it reads;
 * ending a customer's subscriptions is account closure's job.
 *
 * Adopting a subscription and keeping it current are separate rules. A
 * subscription is adopted only when its product is the customer's plan, so a
 * catalog mistake cannot grant a plan. Once adopted it is tracked by id
 * whatever its product, so a plan switch or a repriced product can never stop
 * its end from landing; and it is stored with the plan its product grants now
 * (`grantedPlan`), so a switch to another product ends the plan it left.
 */

export type SubscriptionStoreEnv = PolarCatalogConfig;

/** Polar's statuses onto ours. `incomplete_expired` never started: ended. */
const POLAR_STATUSES: Record<string, Exclude<SubscriptionStatus, null>> = {
  active: "active",
  trialing: "trialing",
  past_due: "past_due",
  unpaid: "unpaid",
  incomplete: "incomplete",
  paused: "paused",
  canceled: "canceled",
  incomplete_expired: "canceled",
};

/** Every Polar status a subscription can still leave: the ones worth re-reading. */
export const LIVE_POLAR_STATUSES: readonly string[] = Object.keys(POLAR_STATUSES)
  .filter((status) => POLAR_STATUSES[status] !== ENDED_SUBSCRIPTION_STATUS);

/** Whether Polar has ended this subscription for good (or never started it). */
export function hasEnded(subscription: Pick<PolarSubscription, "status">): boolean {
  return POLAR_STATUSES[subscription.status] === ENDED_SUBSCRIPTION_STATUS;
}

type StoreOutcome =
  | { kind: "stored"; adoptionRefused: string | null }
  | { kind: "foreign" }
  | { kind: "orphan" }
  | { kind: "not_adopted"; reason: string };

function customerExistsSql(customer: BillingCustomer) {
  return customer.kind === "user"
    ? sql`select 1 from ${users} where ${users.id} = ${customer.userId}`
    : sql`select 1 from ${organizations} where ${organizations.id} = ${customer.organizationId}`;
}

/**
 * The plan this subscription's product grants its customer: theirs when it is
 * their plan's configured product, none for any other (a product added in
 * Polar but not here, one switched to in Polar's portal, a typo, or the other
 * server's id).
 */
function grantedPlan(
  env: PolarCatalogConfig,
  customer: BillingCustomer,
  subscription: PolarSubscription,
): PaidSubscriptionTier | null {
  const plan = planForCustomer(customer);
  return subscription.product_id.toLowerCase() === polarProductIdForPlan(env, plan) ? plan : null;
}

/** Why this subscription may not become a customer's plan, or null when it may. */
function adoptionRefusal(
  customer: BillingCustomer,
  plan: PaidSubscriptionTier | null,
  seats: number | null,
): string | null {
  if (plan === null) return `product is not the configured ${planForCustomer(customer)} product`;
  if (customer.kind === "organization" && seats === null) return "the Organization product is not seat-based";
  return null;
}

async function storeSubscription(
  db: Database,
  env: PolarCatalogConfig,
  subscription: PolarSubscription,
): Promise<StoreOutcome> {
  const customer = parseCustomerExternalId(subscription.customer.external_id);
  if (!customer) return { kind: "foreign" };

  const status = Object.hasOwn(POLAR_STATUSES, subscription.status) ? POLAR_STATUSES[subscription.status] : undefined;
  if (!status) return { kind: "not_adopted", reason: `unknown status "${subscription.status}"` };
  const seats = customer.kind === "organization" && (subscription.seats ?? 0) >= 1 ? subscription.seats! : null;
  const plan = grantedPlan(env, customer, subscription);
  const refusal = adoptionRefusal(customer, plan, seats);

  const cancelAtPeriodEnd = subscription.cancel_at_period_end ? 1 : 0;
  const currentPeriodEnd = subscription.current_period_end ? Date.parse(subscription.current_period_end) : null;
  const version = subscriptionVersion(subscription);

  const result = refusal === null
    ? await db.run(sql`
        insert into ${billingSubscriptions} (
          id, user_id, organization_id, status, seats,
          cancel_at_period_end, current_period_end, plan, source_version
        )
        select
          ${subscription.id},
          ${customer.kind === "user" ? customer.userId : null},
          ${customer.kind === "organization" ? customer.organizationId : null},
          ${status}, ${seats}, ${cancelAtPeriodEnd}, ${currentPeriodEnd}, ${plan}, ${version}
        where exists (${customerExistsSql(customer)})
        on conflict (id) do update set
          status = excluded.status,
          seats = excluded.seats,
          cancel_at_period_end = excluded.cancel_at_period_end,
          current_period_end = excluded.current_period_end,
          plan = excluded.plan,
          source_version = excluded.source_version
        where excluded.source_version > ${billingSubscriptions.sourceVersion}
      `)
    // Not adoptable: keep an already-tracked subscription current, and
    // nothing more. It grants what its product grants now, which for another
    // product is nothing. An Organization keeps its last seat count when the
    // new product carries none.
    : await db.run(sql`
        update ${billingSubscriptions} set
          status = ${status},
          plan = ${plan},
          seats = coalesce(${seats}, ${billingSubscriptions.seats}),
          cancel_at_period_end = ${cancelAtPeriodEnd},
          current_period_end = ${currentPeriodEnd},
          source_version = ${version}
        where ${billingSubscriptions.id} = ${subscription.id}
          and ${billingSubscriptions.sourceVersion} < ${version}
      `);
  if (getRunChanges(result) > 0) return { kind: "stored", adoptionRefused: refusal };

  // Nothing written: a newer snapshot is already stored, the subscription was
  // never adopted, or the customer's row is gone (and with it, by cascade,
  // any stored row).
  const [stored] = await db
    .select({ id: billingSubscriptions.id })
    .from(billingSubscriptions)
    .where(eq(billingSubscriptions.id, subscription.id))
    .limit(1);
  if (stored) return { kind: "stored", adoptionRefused: refusal };
  return refusal === null ? { kind: "orphan" } : { kind: "not_adopted", reason: refusal };
}

/**
 * Bring billing in line with one subscription snapshot from Polar. Safe to
 * call with stale or repeated snapshots, in any order.
 *
 * What cannot be stored is logged and left alone: retrying would not change
 * it, and the daily reconciliation reads it again (logging again) until the
 * catalog or the code is fixed.
 */
export async function syncSubscription(
  db: Database,
  env: SubscriptionStoreEnv,
  subscription: PolarSubscription,
): Promise<void> {
  const outcome = await storeSubscription(db, env, subscription);
  const context = {
    subscriptionId: subscription.id,
    customer: subscription.customer.external_id ?? subscription.customer.id,
    status: subscription.status,
    productId: subscription.product_id,
  };
  switch (outcome.kind) {
    case "stored":
      if (outcome.adoptionRefused) {
        logWarn(`[billing] Tracking a subscription billing would not adopt: ${outcome.adoptionRefused}`, context);
      }
      return;
    case "foreign":
      // Sold outside billing (a dashboard checkout link, a manual order): no
      // customer here can claim it.
      logError("[billing] Subscription belongs to no customer of ours; left untouched", context);
      return;
    case "not_adopted":
      logError(`[billing] Subscription not stored: ${outcome.reason}`, context);
      return;
    case "orphan":
      // The customer is not in this database: erased (account closure ended
      // its subscriptions), or another deployment's customer sharing this
      // Polar organization. Neither is this deployment's to act on.
      logWarn("[billing] Subscription's customer does not exist here; left untouched", context);
      return;
  }
}

/** The subscription a customer manages: the newest one that has not ended. */
export async function findLiveSubscriptionId(db: Database, customer: BillingCustomer): Promise<string | null> {
  const [live] = await db
    .select({ id: billingSubscriptions.id })
    .from(billingSubscriptions)
    .where(and(
      customer.kind === "user"
        ? eq(billingSubscriptions.userId, customer.userId)
        : eq(billingSubscriptions.organizationId, customer.organizationId),
      ne(billingSubscriptions.status, ENDED_SUBSCRIPTION_STATUS),
    ))
    .orderBy(desc(billingSubscriptions.sourceVersion))
    .limit(1);
  return live?.id ?? null;
}
