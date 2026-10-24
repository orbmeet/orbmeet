import type { SubscriptionStatus } from "./types";

/** Paddle still owns a resumable/actionable subscription in these states. */
export function hasPaddleManagedSubscription(
  status: SubscriptionStatus,
): boolean {
  return status !== null && status !== "canceled";
}

/**
 * Whether Paddle still owns the user's subscription lifecycle.
 *
 * Either field is sufficient because webhook reconciliation can temporarily
 * leave one half of the local projection stale. All UI and API gates must use
 * this same fail-closed rule so users are never offered a checkout the server
 * will reject.
 */
export function hasManagedPaddleSubscription(input: {
  subscriptionId: string | null;
  subscriptionStatus: SubscriptionStatus;
}): boolean {
  return Boolean(input.subscriptionId) || hasPaddleManagedSubscription(input.subscriptionStatus);
}

/** Only these Paddle states grant paid product entitlements. */
export function hasSubscriptionEntitlements(
  status: SubscriptionStatus,
): boolean {
  return status === "active" || status === "trialing";
}
