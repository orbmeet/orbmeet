import "@tanstack/react-start/server-only";

import { createDb, type Database } from "@orbmeet/db";
import { billingSubscriptions, organizationMembers } from "@orbmeet/db/schema";
import { count, inArray, ne } from "drizzle-orm";
import { runSerially } from "@/app/serial/serial";
import { logError } from "@/lib/logger";
import { ENDED_SUBSCRIPTION_STATUS } from "@/modules/billing/contract/subscription";
import { parseCustomerExternalId } from "./customer-ids";
import { getSubscription, listSubscriptionsByStatus, polarClientFromEnv } from "./polar";
import type { PolarSubscription } from "./polar-schema";
import { seatChangeFor } from "./organization-seats.server";
import { LIVE_POLAR_STATUSES, syncSubscription } from "./subscription-store.server";

/**
 * Polar's 100-per-page list, bounded so one run stays well inside a Worker's
 * subrequest budget: 50 pages is 5,000 live subscriptions.
 */
const MAX_PAGES = 50;

/**
 * The daily backstop for webhooks. It reads every subscription Polar holds as
 * live (any status but ended) and stores each, which lands any event that was never delivered;
 * re-reads every locally running subscription Polar no longer lists, which
 * lands an end that was missed; and queues a seat correction for every
 * Organization whose paid seats differ from its members.
 */
export async function reconcileSubscriptions(db: Database, env: Env): Promise<number> {
  const client = polarClientFromEnv(env);
  if (!client) return 0;
  const failures: unknown[] = [];
  const seen = new Set<string>();
  const organizationSubscriptions: Array<{ organizationId: string; subscription: PolarSubscription }> = [];

  let page = 1;
  for (; page <= MAX_PAGES; page += 1) {
    const { subscriptions, lastPage } = await listSubscriptionsByStatus(client, LIVE_POLAR_STATUSES, page);
    for (const subscription of subscriptions) {
      seen.add(subscription.id);
      try {
        await syncSubscription(db, env, subscription);
      } catch (error) {
        failures.push(error);
      }
      const customer = parseCustomerExternalId(subscription.customer.external_id);
      if (customer?.kind === "organization") {
        organizationSubscriptions.push({ organizationId: customer.organizationId, subscription });
      }
    }
    if (lastPage) break;
  }
  if (page > MAX_PAGES) {
    logError("[billing-reconciliation] More active subscriptions than one run reads; raise MAX_PAGES or page across runs", {
      maxPages: MAX_PAGES,
    });
  }

  const running = await db
    .select({ id: billingSubscriptions.id })
    .from(billingSubscriptions)
    .where(ne(billingSubscriptions.status, ENDED_SUBSCRIPTION_STATUS));
  for (const { id } of running) {
    if (seen.has(id)) continue;
    try {
      const subscription = await getSubscription(client, id);
      if (subscription) {
        await syncSubscription(db, env, subscription);
      } else {
        // Polar never deletes a subscription; it cancels it. A miss means this
        // deployment points at the wrong Polar server or organization, and
        // acting on it would end every customer's plan at once.
        logError("[billing-reconciliation] Polar has no such subscription; check POLAR_SERVER and the token", {
          subscriptionId: id,
        });
      }
    } catch (error) {
      failures.push(error);
    }
  }

  if (organizationSubscriptions.length > 0) {
    const memberCounts = new Map(
      (await db
        .select({ organizationId: organizationMembers.organizationId, value: count() })
        .from(organizationMembers)
        .where(inArray(organizationMembers.organizationId, organizationSubscriptions.map((entry) => entry.organizationId)))
        .groupBy(organizationMembers.organizationId))
        .map((row) => [row.organizationId, row.value]),
    );
    for (const { organizationId, subscription } of organizationSubscriptions) {
      if (!seatChangeFor(subscription, memberCounts.get(organizationId) ?? 0)) continue;
      try {
        await runSerially(env, { kind: "syncOrganizationSeats", organizationId });
      } catch (error) {
        failures.push(error);
      }
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(failures, "Subscription reconciliation completed with failures");
  }
  return seen.size;
}

export async function runSubscriptionReconciliation(env: Env): Promise<number> {
  return reconcileSubscriptions(createDb(env.DB), env);
}
