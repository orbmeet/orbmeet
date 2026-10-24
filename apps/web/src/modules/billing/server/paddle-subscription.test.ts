import { describe, expect, it } from "vitest";
import {
  parsePaddleWebhookEvent,
  resolvePaddleSubscriptionState,
  type PaddlePriceConfig,
} from "./paddle-subscription";
import { configuredPaddlePriceId } from "@/modules/billing/server/paddle-config";

const env = {
  PADDLE_PRICE_ID_PRO: "pri_01test0000000000000000pro",
  PADDLE_PRICE_ID_ORG_SEAT: "pri_01test000000000000000seat",
} satisfies PaddlePriceConfig;

describe("configuredPaddlePriceId", () => {
  it("rejects empty and committed placeholder values", () => {
    expect(configuredPaddlePriceId("")).toBeUndefined();
    expect(configuredPaddlePriceId("pri_YOUR_PRICE_ID_HERE")).toBeUndefined();
    expect(configuredPaddlePriceId("change-me")).toBeUndefined();
  });

  // A typo that is neither empty nor a recognizable placeholder used to reach
  // Paddle and come back as an opaque 400 mid-checkout.
  it("rejects a value that is not a Paddle price id", () => {
    expect(configuredPaddlePriceId("gvv")).toBeUndefined();
    expect(configuredPaddlePriceId("pro_01abc")).toBeUndefined();
    expect(configuredPaddlePriceId("pri_")).toBeUndefined();
  });

  it("trims and returns a configured catalog id", () => {
    expect(configuredPaddlePriceId("  pri_01abc  ")).toBe("pri_01abc");
  });
});

describe("resolvePaddleSubscriptionState", () => {
  it("finds the plan item when an add-on appears first", () => {
    expect(resolvePaddleSubscriptionState({
      status: "active",
      items: [
        { price: { id: "addon_recording" } },
        { price: { id: "pri_01test0000000000000000pro" } },
      ],
    }, env)).toEqual({ resolved: true, status: "active", plan: "pro" });
  });

  it("leaves durable entitlements unchanged for an unknown configured price", () => {
    expect(resolvePaddleSubscriptionState({
      status: "trialing",
      items: [{ price: { id: "pri_01test00000000000000othr" } }],
    }, env)).toEqual({ resolved: false, reason: "unresolved-catalog", status: "trialing", plan: null });
  });

  it("leaves entitlements unchanged when a catalog entry is temporarily missing", () => {
    expect(resolvePaddleSubscriptionState({
      status: "active",
      items: [{ price: { id: "pri_01test000000000000000seat" } }],
    }, { ...env, PADDLE_PRICE_ID_ORG_SEAT: "pri_YOUR_PRICE_ID_HERE" }))
      .toEqual({ resolved: false, reason: "unresolved-catalog", status: "active", plan: null });
  });

  // A status Paddle added after this build shipped. No configuration change
  // makes a retry succeed, so it is reported separately from an unresolved
  // catalog — the callers acknowledge it instead of retrying forever — and it
  // still never guesses at entitlements.
  it("reports an unrecognized status without guessing entitlements", () => {
    expect(resolvePaddleSubscriptionState({
      status: "some_future_status",
      items: [{ price: { id: "pri_01test0000000000000000pro" } }],
    }, env)).toEqual({
      resolved: false,
      reason: "unknown-status",
      status: null,
      plan: null,
    });
  });

  it("downgrades a terminal subscription regardless of its old price", () => {
    expect(resolvePaddleSubscriptionState({
      status: "canceled",
      items: [{ price: { id: "pri_01test00000000000000retd" } }],
    }, env)).toEqual({ resolved: true, status: "canceled", plan: "free" });
  });
});

describe("parsePaddleWebhookEvent", () => {
  it("normalizes a subscription update after validating its nested data", () => {
    expect(parsePaddleWebhookEvent({
      event_id: "evt_1",
      event_type: "subscription.updated",
      occurred_at: "2026-08-09T12:00:00Z",
      data: {
        id: "sub_1",
        customer_id: "ctm_1",
        status: "active",
        items: [{ price: { id: "pri_01test0000000000000000pro" }, quantity: 1 }],
      },
    })).toEqual({
      kind: "subscription-upsert",
      eventId: "evt_1",
      eventType: "subscription.updated",
      occurredAt: "2026-08-09T12:00:00Z",
      data: {
        id: "sub_1",
        customer_id: "ctm_1",
        status: "active",
        items: [{ price: { id: "pri_01test0000000000000000pro" }, quantity: 1 }],
      },
    });
  });

  it("rejects malformed known events instead of trusting asserted field types", () => {
    expect(parsePaddleWebhookEvent({
      event_type: "subscription.updated",
      data: {
        id: 123,
        customer_id: "ctm_1",
        status: "active",
        items: "not-an-array",
      },
    })).toBeNull();
  });

  it("retains valid unknown events as ignored records", () => {
    expect(parsePaddleWebhookEvent({
      event_type: "transaction.completed",
      data: { id: "txn_1" },
    })).toMatchObject({
      kind: "ignored",
      eventType: "transaction.completed",
      data: { id: "txn_1" },
    });
  });

  it("normalizes a refund adjustment so it can end an entitlement", () => {
    expect(parsePaddleWebhookEvent({
      event_id: "evt_adj",
      event_type: "adjustment.created",
      data: {
        id: "adj_1",
        action: "refund",
        type: "full",
        status: "approved",
        subscription_id: "sub_1",
        customer_id: "ctm_1",
      },
    })).toMatchObject({
      kind: "adjustment",
      eventType: "adjustment.created",
      data: { action: "refund", type: "full", status: "approved", subscription_id: "sub_1" },
    });
  });

  it("reads an approval that arrives as adjustment.updated as an adjustment too", () => {
    expect(parsePaddleWebhookEvent({
      event_id: "evt_adj_approved",
      event_type: "adjustment.updated",
      data: { id: "adj_1", action: "refund", type: "full", status: "approved", subscription_id: "sub_1" },
    })).toMatchObject({ kind: "adjustment", eventType: "adjustment.updated", data: { status: "approved" } });
  });

  it("acknowledges a shapeless adjustment as ignored rather than reject-looping", () => {
    expect(parsePaddleWebhookEvent({
      event_type: "adjustment.created",
      data: { id: "adj_2" },
    })).toMatchObject({ kind: "ignored", eventType: "adjustment.created" });
  });
});
