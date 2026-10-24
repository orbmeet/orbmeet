import { describe, expect, it, vi } from "vitest";
import { resolveDuplicateSubscription } from "./duplicate-subscription";

const base = { incomingSubscriptionId: "sub_incoming" };

/** Paddle's answer for each id, so a test states the world rather than a call order. */
function paddleStatuses(statuses: Record<string, string | null>) {
  return vi.fn(async (subscriptionId: string) => {
    if (!(subscriptionId in statuses)) {
      throw new Error(`Unexpected Paddle lookup for ${subscriptionId}`);
    }
    return statuses[subscriptionId]!;
  });
}

describe("resolveDuplicateSubscription", () => {
  it("cancels the incoming subscription when the stored one is live at Paddle", async () => {
    const decision = await resolveDuplicateSubscription({
      ...base,
      storedSubscriptionId: "sub_stored",
      lookupStatus: paddleStatuses({ sub_stored: "active", sub_incoming: "active" }),
    });

    expect(decision).toEqual({
      action: "cancel-incoming",
      retainedSubscriptionId: "sub_stored",
      storedStatus: "active",
    });
  });

  it("adopts the incoming subscription when Paddle has already canceled the stored one", async () => {
    const decision = await resolveDuplicateSubscription({
      ...base,
      storedSubscriptionId: "sub_stored",
      lookupStatus: paddleStatuses({ sub_stored: "canceled" }),
    });

    expect(decision.action).toBe("adopt");
  });

  it("adopts the incoming subscription when the stored id names nothing at Paddle", async () => {
    const decision = await resolveDuplicateSubscription({
      ...base,
      storedSubscriptionId: "sub_abandoned_checkout",
      lookupStatus: paddleStatuses({ sub_abandoned_checkout: null }),
    });

    expect(decision.action).toBe("adopt");
  });

  it("never cancels on the strength of a stored id alone", async () => {
    const lookupStatus = paddleStatuses({ sub_stored: "past_due", sub_incoming: "active" });

    await resolveDuplicateSubscription({
      ...base,
      storedSubscriptionId: "sub_stored",
      lookupStatus,
    });

    expect(lookupStatus).toHaveBeenCalledWith("sub_stored");
  });

  it("propagates an unreachable Paddle instead of guessing", async () => {
    await expect(resolveDuplicateSubscription({
      ...base,
      storedSubscriptionId: "sub_stored",
      lookupStatus: async () => {
        throw new Error("Paddle GET /subscriptions/sub_stored → 503");
      },
    })).rejects.toThrow("503");
  });

  it("ignores a duplicate Paddle has already canceled, whatever the event said", async () => {
    // The event body is a snapshot of a moment that may have passed. A
    // redelivery of "subscription created" for a subscription since canceled
    // used to issue a cancel for a subscription that is already gone.
    const decision = await resolveDuplicateSubscription({
      ...base,
      storedSubscriptionId: "sub_stored",
      lookupStatus: paddleStatuses({ sub_stored: "active", sub_incoming: "canceled" }),
    });

    expect(decision).toEqual({
      action: "ignore",
      retainedSubscriptionId: "sub_stored",
      storedStatus: "active",
    });
  });

  it("ignores a duplicate that no longer exists at Paddle", async () => {
    const decision = await resolveDuplicateSubscription({
      ...base,
      storedSubscriptionId: "sub_stored",
      lookupStatus: paddleStatuses({ sub_stored: "active", sub_incoming: null }),
    });

    expect(decision.action).toBe("ignore");
  });

  it("asks Paddle nothing when there is no stored id to protect", async () => {
    const lookupStatus = paddleStatuses({ sub_stored: "active", sub_incoming: "active" });

    for (const storedSubscriptionId of [null, base.incomingSubscriptionId]) {
      const decision = await resolveDuplicateSubscription({
        ...base,
        storedSubscriptionId,
        lookupStatus,
      });
      expect(decision.action).toBe("adopt");
    }
    expect(lookupStatus).not.toHaveBeenCalled();
  });
});
