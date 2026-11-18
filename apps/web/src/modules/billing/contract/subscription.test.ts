import { describe, expect, it } from "vitest";
import { grantsEntitlements, isLiveSubscription } from "./subscription";

describe("subscription entitlement rules", () => {
  it.each(["active", "trialing", "past_due"] as const)("%s grants the plan", (status) => {
    expect(grantsEntitlements(status)).toBe(true);
  });

  it.each(["unpaid", "incomplete", "paused", "canceled", null] as const)("%s grants nothing", (status) => {
    expect(grantsEntitlements(status)).toBe(false);
  });

  it.each(["active", "trialing", "past_due", "unpaid", "incomplete", "paused"] as const)(
    "a %s subscription is still running, so it is managed, not bought again",
    (status) => {
      expect(isLiveSubscription(status)).toBe(true);
    },
  );

  it("only a canceled subscription, or none, leaves room for a new checkout", () => {
    expect(isLiveSubscription("canceled")).toBe(false);
    expect(isLiveSubscription(null)).toBe(false);
  });
});
