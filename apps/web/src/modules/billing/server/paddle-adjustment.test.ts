import { beforeEach, expect, it, vi } from "vitest";

const paddle = vi.hoisted(() => ({
  cancelSubscription: vi.fn().mockResolvedValue(undefined),
  removeScheduledChange: vi.fn().mockResolvedValue(undefined),
  getSubscription: vi.fn().mockResolvedValue({ id: "sub_1", status: "active" }),
}));
vi.mock("@/modules/billing/server/paddle", async (original) => ({
  ...await original<typeof import("@/modules/billing/server/paddle")>(),
  ...paddle,
}));

import { handlePaddleEvent } from "@/modules/billing/server/paddle-webhook.server";
import { PaddleApiError } from "@/modules/billing/server/paddle";
import type { ParsedPaddleEvent } from "./paddle-subscription";

// The adjustment path never touches the database, so a stub stands in for it.
const db = {} as never;
const env = { PADDLE_API_KEY: "test" } as unknown as Env;

function adjustment(
  data: Partial<Extract<ParsedPaddleEvent, { kind: "adjustment" }>["data"]>,
): ParsedPaddleEvent {
  return {
    kind: "adjustment",
    eventType: "adjustment.created",
    data: { id: "adj_1", action: "refund", subscription_id: "sub_1", ...data },
  };
}

beforeEach(() => {
  paddle.cancelSubscription.mockClear();
  paddle.removeScheduledChange.mockClear();
  paddle.getSubscription.mockClear();
  paddle.getSubscription.mockResolvedValue({ id: "sub_1", status: "active" });
});

it("cancels the subscription after a full approved refund", async () => {
  await handlePaddleEvent(db, adjustment({ action: "refund", type: "full", status: "approved" }), env);
  expect(paddle.cancelSubscription).toHaveBeenCalledWith("test", "sub_1", "immediately");
});

it("cancels the subscription after a chargeback", async () => {
  await handlePaddleEvent(db, adjustment({ action: "chargeback", type: "full", status: "approved" }), env);
  expect(paddle.cancelSubscription).toHaveBeenCalledWith("test", "sub_1", "immediately");
});

it("leaves the subscription for a partial refund", async () => {
  await handlePaddleEvent(db, adjustment({ action: "refund", type: "partial", status: "approved" }), env);
  expect(paddle.cancelSubscription).not.toHaveBeenCalled();
});

it("leaves the subscription for a full refund still awaiting approval", async () => {
  await handlePaddleEvent(db, adjustment({ action: "refund", type: "full", status: "pending_approval" }), env);
  expect(paddle.cancelSubscription).not.toHaveBeenCalled();
});

it("does not act on a chargeback warning that may never become a chargeback", async () => {
  await handlePaddleEvent(db, adjustment({ action: "chargeback_warning", type: "full", status: "approved" }), env);
  expect(paddle.cancelSubscription).not.toHaveBeenCalled();
});

it("does nothing for an entitlement-ending adjustment with no subscription", async () => {
  await handlePaddleEvent(
    db,
    adjustment({ action: "chargeback", subscription_id: null }),
    env,
  );
  expect(paddle.getSubscription).not.toHaveBeenCalled();
  expect(paddle.cancelSubscription).not.toHaveBeenCalled();
});

it("does not re-cancel a subscription already canceled at Paddle", async () => {
  paddle.getSubscription.mockResolvedValue({ id: "sub_1", status: "canceled" });
  await handlePaddleEvent(db, adjustment({ action: "chargeback", type: "full", status: "approved" }), env);
  expect(paddle.cancelSubscription).not.toHaveBeenCalled();
});

it("treats a subscription Paddle no longer knows as already ended", async () => {
  paddle.getSubscription.mockRejectedValue(new PaddleApiError(404, "gone"));
  await expect(
    handlePaddleEvent(db, adjustment({ action: "chargeback", type: "full", status: "approved" }), env),
  ).resolves.toBeUndefined();
  expect(paddle.cancelSubscription).not.toHaveBeenCalled();
});

it("redelivers when the subscription lookup fails transiently", async () => {
  paddle.getSubscription.mockRejectedValue(new PaddleApiError(503, "upstream"));
  await expect(
    handlePaddleEvent(db, adjustment({ action: "chargeback", type: "full", status: "approved" }), env),
  ).rejects.toThrow();
  expect(paddle.cancelSubscription).not.toHaveBeenCalled();
});

it("cancels once Paddle approves a refund that was awaiting approval", async () => {
  await handlePaddleEvent(db, {
    ...adjustment({ action: "refund", type: "full", status: "approved" }),
    eventType: "adjustment.updated",
  } as ParsedPaddleEvent, env);
  expect(paddle.cancelSubscription).toHaveBeenCalledWith("test", "sub_1", "immediately");
});

it("ends access now even when a cancellation is already scheduled for the period's end", async () => {
  paddle.getSubscription.mockResolvedValue({
    id: "sub_1",
    status: "active",
    scheduled_change: { action: "cancel", effective_at: "2026-11-01T00:00:00Z" },
  });
  await handlePaddleEvent(db, adjustment({ action: "refund", type: "full", status: "approved" }), env);
  expect(paddle.removeScheduledChange).toHaveBeenCalledWith("test", "sub_1");
  expect(paddle.cancelSubscription).toHaveBeenCalledWith("test", "sub_1", "immediately");
  expect(paddle.removeScheduledChange.mock.invocationCallOrder[0])
    .toBeLessThan(paddle.cancelSubscription.mock.invocationCallOrder[0]);
});
