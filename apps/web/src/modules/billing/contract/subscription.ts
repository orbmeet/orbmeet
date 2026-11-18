import type { SubscriptionStatus } from "./types";

/**
 * The statuses that grant a plan's entitlements. `past_due` is among them:
 * features continue while the billing provider retries the card, and end when
 * it gives up (`unpaid`) or the subscription is canceled.
 */
export const ENTITLED_SUBSCRIPTION_STATUSES = [
  "active",
  "trialing",
  "past_due",
] as const satisfies readonly Exclude<SubscriptionStatus, null>[];

export function grantsEntitlements(status: SubscriptionStatus): boolean {
  return (ENTITLED_SUBSCRIPTION_STATUSES as readonly SubscriptionStatus[]).includes(status);
}

/**
 * The one status a subscription never leaves. Every other status is "live":
 * still running at the billing provider, entitled or not. Server queries
 * compare against this constant rather than restating the rule.
 */
export const ENDED_SUBSCRIPTION_STATUS = "canceled" as const satisfies Exclude<SubscriptionStatus, null>;

/**
 * Whether a subscription is still running at the billing provider, entitled or
 * not. A customer with one manages it in the billing portal; buying another
 * is refused.
 */
export function isLiveSubscription(status: SubscriptionStatus): boolean {
  return status !== null && status !== ENDED_SUBSCRIPTION_STATUS;
}
