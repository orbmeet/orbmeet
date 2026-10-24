import { describe, expect, it } from "vitest";
import {
  hasManagedPaddleSubscription,
  hasPaddleManagedSubscription,
  hasSubscriptionEntitlements,
} from "./subscription";

describe("billing subscription state", () => {
  it.each(["active", "trialing", "past_due", "paused"] as const)(
    "keeps %s subscriptions in the existing-subscription workflow",
    (status) => {
      expect(hasPaddleManagedSubscription(status)).toBe(true);
    },
  );

  it("allows a new checkout only after Paddle has fully canceled the old subscription", () => {
    expect(hasPaddleManagedSubscription("canceled")).toBe(false);
    expect(hasPaddleManagedSubscription(null)).toBe(false);
  });

  // The checkout endpoint gates on this: any of these states means Paddle
  // still owns a subscription, so a second checkout must be refused.
  it.each(["active", "trialing", "past_due", "paused"] as const)(
    "blocks a second checkout for a %s subscription",
    (subscriptionStatus) => {
      expect(hasManagedPaddleSubscription({
        subscriptionId: "sub_existing",
        subscriptionStatus,
      })).toBe(true);
    },
  );

  it("fails closed when either half of the managed-subscription projection remains", () => {
    expect(hasManagedPaddleSubscription({
      subscriptionId: "sub_existing",
      subscriptionStatus: null,
    })).toBe(true);
    expect(hasManagedPaddleSubscription({
      subscriptionId: null,
      subscriptionStatus: "active",
    })).toBe(true);
    expect(hasManagedPaddleSubscription({
      subscriptionId: null,
      subscriptionStatus: "canceled",
    })).toBe(false);
    expect(hasManagedPaddleSubscription({
      subscriptionId: "sub_stale_terminal",
      subscriptionStatus: "canceled",
    })).toBe(true);
  });

  it("grants entitlements only to active and trialing subscriptions", () => {
    expect(hasSubscriptionEntitlements("active")).toBe(true);
    expect(hasSubscriptionEntitlements("trialing")).toBe(true);
    expect(hasSubscriptionEntitlements("past_due")).toBe(false);
    expect(hasSubscriptionEntitlements("paused")).toBe(false);
    expect(hasSubscriptionEntitlements("canceled")).toBe(false);
    expect(hasSubscriptionEntitlements(null)).toBe(false);
  });
});
