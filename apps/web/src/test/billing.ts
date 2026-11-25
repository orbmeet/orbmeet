import type { Database } from "@orbmeet/db";
import { billingSubscriptions } from "@orbmeet/db/schema";
import type { SubscriptionStatus } from "@/modules/billing/contract/types";

/**
 * Give a user Pro, or an Organization its plan and seats, the way billing
 * would after a checkout: a stored subscription. Plans are derived from these
 * rows, so tests seed them instead of a plan column.
 */
export async function seedSubscription(
  db: Database,
  customer: { userId: string } | { organizationId: string; seats?: number },
  options: { id?: string; status?: Exclude<SubscriptionStatus, null>; cancelAtPeriodEnd?: boolean } = {},
): Promise<string> {
  const id = options.id ?? `sub_${"userId" in customer ? customer.userId : customer.organizationId}`;
  await db.insert(billingSubscriptions).values({
    id,
    userId: "userId" in customer ? customer.userId : null,
    organizationId: "organizationId" in customer ? customer.organizationId : null,
    status: options.status ?? "active",
    seats: "organizationId" in customer ? customer.seats ?? 25 : null,
    cancelAtPeriodEnd: options.cancelAtPeriodEnd ?? false,
    currentPeriodEnd: null,
    plan: "userId" in customer ? "pro" : "organization",
    sourceVersion: 0,
  });
  return id;
}
