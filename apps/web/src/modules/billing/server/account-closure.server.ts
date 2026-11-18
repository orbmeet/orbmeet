import "@tanstack/react-start/server-only";

import type { Database } from "@orbmeet/db";
import { billingSubscriptions } from "@orbmeet/db/schema";
import { eq } from "drizzle-orm";
import { Errors } from "@/lib/app-errors";
import { customerExternalId } from "./customer-ids";
import {
  deleteCustomer,
  isAlreadyEnded,
  listCustomerSubscriptions,
  polarClientFromEnv,
  revokeSubscription,
  type PolarClient,
} from "./polar";
import { hasEnded } from "./subscription-store.server";

async function revokeUnlessEnded(client: PolarClient, subscriptionId: string): Promise<void> {
  try {
    await revokeSubscription(client, subscriptionId);
  } catch (error) {
    if (!isAlreadyEnded(error)) throw error;
  }
}

/**
 * Close a person's billing before their account is erased: end every
 * subscription they have now, then delete their Polar customer, anonymized.
 *
 * Ending them here, one by one, rather than leaving it to the customer
 * deletion is the point: Polar's deletion cancels only billable
 * subscriptions, so a paused one would survive it and charge the card when
 * it resumes. Ending now rather than at the period's end is deliberate too:
 * the account the period was paid for no longer exists.
 *
 * Organizations are not closed here: an owner must transfer theirs before
 * deleting their account.
 *
 * Idempotent: a retry finds the subscriptions ended and the customer gone.
 */
export async function closeUserBilling(
  db: Database,
  env: { POLAR_ACCESS_TOKEN?: string; POLAR_SERVER?: string },
  userId: string,
): Promise<void> {
  const client = polarClientFromEnv(env);
  if (!client) {
    const [subscription] = await db
      .select({ id: billingSubscriptions.id })
      .from(billingSubscriptions)
      .where(eq(billingSubscriptions.userId, userId))
      .limit(1);
    // Billing is off and this account never subscribed: nothing to close.
    if (!subscription) return;
    throw Errors.CONFIG_ERROR("Billing is temporarily unavailable; the account was not deleted");
  }
  // A failed call is transient: the deletion aborts (its marker stays) and a
  // retry starts over.
  const externalId = customerExternalId({ kind: "user", userId });
  for (const subscription of await listCustomerSubscriptions(client, externalId)) {
    if (!hasEnded(subscription)) await revokeUnlessEnded(client, subscription.id);
  }
  await deleteCustomer(client, externalId);
}
