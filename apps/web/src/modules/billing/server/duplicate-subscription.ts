/**
 * What to do with a subscription event whose id is not the one we have stored.
 *
 * - `adopt`: the stored id no longer names a live subscription, so the incoming
 *   one becomes the managed subscription and the normal upsert proceeds.
 * - `cancel-incoming`: the stored subscription is confirmed live at Paddle, so
 *   this really is a duplicate and gets canceled immediately.
 * - `ignore`: a duplicate that is already canceled. There is nothing to cancel
 *   and nothing to adopt; touching local state would overwrite the live
 *   subscription's projection with a dead subscription's.
 */
export type DuplicateSubscriptionDecision =
  | { action: "adopt"; retainedSubscriptionId: null; storedStatus: string | null }
  | { action: "cancel-incoming"; retainedSubscriptionId: string; storedStatus: string }
  | { action: "ignore"; retainedSubscriptionId: string; storedStatus: string };

/**
 * Decide whether a differing subscription id is a duplicate worth canceling.
 *
 * The whole point of asking Paddle is that the local projection is the thing a
 * webhook exists to repair, so it cannot also be the evidence used to cancel a
 * customer's subscription. `lookupStatus` returns `null` when Paddle confirms
 * an id names nothing, and must throw for any answer it did not get — an
 * unreachable Paddle has to fail the webhook, not decide it.
 *
 * Both ids are read from Paddle, for the same reason. The incoming status used
 * to come from the event body, and a webhook body is a snapshot of a moment
 * that may have passed: a redelivery of "subscription created" for a
 * subscription since canceled would issue a cancel for a subscription that is
 * already gone. Reading it makes the decision reflect now, and makes repeated
 * deliveries of the same event settle to the same no-op.
 */
export async function resolveDuplicateSubscription(input: {
  storedSubscriptionId: string | null;
  incomingSubscriptionId: string;
  lookupStatus: (subscriptionId: string) => Promise<string | null>;
}): Promise<DuplicateSubscriptionDecision> {
  const { storedSubscriptionId, incomingSubscriptionId } = input;

  // Same subscription, or no stored id to protect: nothing is at risk either
  // way, so the event is applied as an ordinary update.
  if (!storedSubscriptionId || storedSubscriptionId === incomingSubscriptionId) {
    return { action: "adopt", retainedSubscriptionId: null, storedStatus: null };
  }

  const storedStatus = await input.lookupStatus(storedSubscriptionId);
  if (storedStatus === null || storedStatus === "canceled") {
    return { action: "adopt", retainedSubscriptionId: null, storedStatus };
  }

  const incomingStatus = await input.lookupStatus(incomingSubscriptionId);
  return {
    action: incomingStatus === null || incomingStatus === "canceled"
      ? "ignore"
      : "cancel-incoming",
    retainedSubscriptionId: storedSubscriptionId,
    storedStatus,
  };
}
