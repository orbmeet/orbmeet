import { describe, expect, it } from "vitest";
import { parsePolarWebhookEvent } from "./polar-schema";

const subscription = {
  id: "sub_1",
  status: "active",
  product_id: "22222222-2222-4222-8222-222222222222",
  seats: null,
  cancel_at_period_end: false,
  current_period_end: null,
  created_at: "2026-11-01T00:00:00Z",
  modified_at: null,
  customer: { id: "cus_1", external_id: "user:u_1" },
  pending_update: null,
};

describe("parsePolarWebhookEvent", () => {
  it("reads a subscription event as the subscription it carries", () => {
    expect(parsePolarWebhookEvent({ type: "subscription.updated", data: subscription })).toMatchObject({
      kind: "subscription",
      subscription: { id: "sub_1", status: "active" },
    });
  });

  it("ignores events about anything else", () => {
    expect(parsePolarWebhookEvent({ type: "order.paid", data: {} })).toEqual({ kind: "ignored", eventType: "order.paid" });
  });

  it("names an event it cannot read instead of refusing it", () => {
    expect(parsePolarWebhookEvent({ type: "subscription.updated", data: { id: "sub_1" } }))
      .toEqual({ kind: "unreadable", eventType: "subscription.updated" });
    expect(parsePolarWebhookEvent("not an event")).toEqual({ kind: "unreadable", eventType: null });
  });
});
