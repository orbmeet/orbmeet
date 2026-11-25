import "@tanstack/react-start/server-only";

import type { Database } from "@orbmeet/db";
import { organizationMembers } from "@orbmeet/db/schema";
import { count, eq } from "drizzle-orm";
import { logError, logWarn } from "@/lib/logger";
import {
  getSubscription,
  polarClientFromEnv,
  seatChangeRefusal,
  updateSubscriptionSeats,
  type SeatChangeRefusal,
} from "./polar";
import type { PolarSubscription } from "./polar-schema";
import { findLiveSubscriptionId, syncSubscription, type SubscriptionStoreEnv } from "./subscription-store.server";

type SeatsEnv = SubscriptionStoreEnv & { POLAR_ACCESS_TOKEN?: string; POLAR_SERVER?: string };

/**
 * An Organization pays for one seat per member, never fewer than one. Billing
 * owns that count: checkout sells exactly the members there are, and this
 * file is the only place that changes it afterwards. Adding a member raises
 * seats (invoiced now), removing one lowers them from the next period, and
 * the daily reconciliation repairs any drift, including a change made in
 * Polar's portal. Callers run in the Organization's serial scope, so no two
 * seat changes interleave.
 */

/** Polar refused the change and will keep refusing until somebody acts. */
export class SeatChangeRefusedError extends Error {
  constructor(readonly refusal: SeatChangeRefusal) {
    super(`Polar refused the seat change: ${refusal}`);
    this.name = "SeatChangeRefusedError";
  }
}

/**
 * The Polar statuses whose subscription Polar lets change: its own "active"
 * statuses. It refuses a seat change on any other (`InactiveSubscription`),
 * past due, unpaid, paused and incomplete included.
 */
const SEAT_CHANGEABLE_POLAR_STATUSES: ReadonlySet<string> = new Set(["active", "trialing"]);

/**
 * The seat change that brings a subscription to `memberCount` members, or
 * null when none is needed or none can be made. A decrease waits for the next
 * period (`pending_update`); setting the current count again cancels one
 * already scheduled. A subscription ending at its period's end, or one Polar
 * will not change in its status, takes no changes.
 */
export function seatChangeFor(
  subscription: Pick<PolarSubscription, "status" | "seats" | "pending_update" | "cancel_at_period_end">,
  memberCount: number,
): { seats: number; prorationBehavior: "invoice" | "next_period" } | null {
  const target = Math.max(1, memberCount);
  const current = subscription.seats;
  if (!current || subscription.cancel_at_period_end || !SEAT_CHANGEABLE_POLAR_STATUSES.has(subscription.status)) {
    return null;
  }
  const pending = subscription.pending_update?.seats ?? null;
  if (target > current) return { seats: target, prorationBehavior: "invoice" };
  if (target < current) return pending === target ? null : { seats: target, prorationBehavior: "next_period" };
  return pending !== null && pending !== current ? { seats: target, prorationBehavior: "invoice" } : null;
}

async function memberCountOf(db: Database, organizationId: string): Promise<number> {
  const [{ value = 0 } = {}] = await db
    .select({ value: count() })
    .from(organizationMembers)
    .where(eq(organizationMembers.organizationId, organizationId));
  return value;
}

async function setOrganizationSeats(
  db: Database,
  env: SeatsEnv,
  organizationId: string,
  memberCount: number,
): Promise<void> {
  const liveId = await findLiveSubscriptionId(db, { kind: "organization", organizationId });
  // Never subscribed, or the subscription has ended: no seats to keep.
  if (!liveId) return;
  const client = polarClientFromEnv(env);
  if (!client) throw new Error("Polar is not configured; cannot change Organization seats");

  // Decide on Polar's current state, pending changes included.
  const current = await getSubscription(client, liveId);
  if (!current) {
    logError("[billing] Polar has no such subscription; check POLAR_SERVER and the token", {
      organizationId,
      subscriptionId: liveId,
    });
    return;
  }
  await syncSubscription(db, env, current);
  const change = seatChangeFor(current, memberCount);
  if (!change) {
    // Too few seats and no change possible: the subscription is ending, or
    // in a status Polar will not change it in.
    if ((current.seats ?? 0) < Math.max(1, memberCount)) throw new SeatChangeRefusedError("not_active");
    return;
  }
  try {
    const updated = await updateSubscriptionSeats(client, current.id, change.seats, change.prorationBehavior);
    await syncSubscription(db, env, updated);
  } catch (error) {
    const refusal = seatChangeRefusal(error);
    if (refusal === "below_floor") {
      // The product's minimum, or seats assigned in Polar's portal, hold the
      // count up. The Organization keeps paying for those seats; nothing here
      // can lower them, so it is not a failure.
      logWarn("[billing] Polar would not lower the Organization's seats", {
        organizationId,
        subscriptionId: current.id,
        seats: change.seats,
      });
      return;
    }
    if (refusal) throw new SeatChangeRefusedError(refusal);
    throw error;
  }
}

/**
 * Make room for one more member: seats for every current member and the one
 * about to join. Throws `SeatChangeRefusedError` when Polar declines, and the
 * member must not then be added.
 */
export async function reserveOrganizationSeat(
  db: Database,
  env: SeatsEnv,
  organizationId: string,
): Promise<void> {
  await setOrganizationSeats(db, env, organizationId, (await memberCountOf(db, organizationId)) + 1);
}

/** Bring seats to the members the Organization has now. */
export async function syncOrganizationSeats(
  db: Database,
  env: SeatsEnv,
  organizationId: string,
): Promise<void> {
  await setOrganizationSeats(db, env, organizationId, await memberCountOf(db, organizationId));
}
