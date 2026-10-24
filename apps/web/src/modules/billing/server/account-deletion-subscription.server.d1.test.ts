import { beforeEach, describe, expect, it, vi } from "vitest";
import { users } from "@orbmeet/db/schema";
import { createTestDb, type TestDb } from "@/test/db";

const getSubscriptionMock = vi.hoisted(() => vi.fn());
const cancelSubscriptionMock = vi.hoisted(() => vi.fn());

vi.mock("@/modules/billing/server/paddle", () => ({
  getSubscription: getSubscriptionMock,
  cancelSubscription: cancelSubscriptionMock,
  // The preflight's local list call builds its URL from the shared host pick.
  paddleApiBase: () => "https://api.paddle.com",
}));

import { cancelAccountSubscriptionBeforeDeletion } from "./account-deletion-subscription.server";

let db: TestDb;

// The preflight asks Paddle for every subscription on the customer through its
// own (local) list call, which goes over fetch — the module mock above only
// covers the shared client's single-subscription handles.
const fetchMock = vi.hoisted(() => vi.fn());

function stubSubscriptionList(subscriptions: Array<Record<string, unknown>>) {
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: subscriptions }), { status: 200 }));
}

beforeEach(async () => {
  db = await createTestDb();
  getSubscriptionMock.mockReset();
  cancelSubscriptionMock.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  // Default: the customer has no other subscriptions.
  stubSubscriptionList([]);
  const now = new Date();
  await db.insert(users).values({
    id: "user",
    name: "User",
    email: "user@example.com",
    normalizedEmail: "user@example.com",
    plan: "pro",
    role: "user",
    paddleCustomerId: "ctm_user",
    paddleSubscriptionId: "sub_user",
    subscriptionStatus: "active",
    createdAt: now,
    updatedAt: now,
  });
});

function projectedSubscription(overrides: Record<string, unknown> = {}) {
  return {
    id: "sub_user",
    customer_id: "ctm_user",
    status: "active",
    scheduled_change: null,
    items: [],
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("account-deletion subscription boundary", () => {
  it("cancels a billable subscription before local deletion", async () => {
    getSubscriptionMock.mockResolvedValue({
      id: "sub_user",
      customer_id: "ctm_user",
      status: "active",
      scheduled_change: null,
      items: [],
      updated_at: new Date().toISOString(),
    });

    await cancelAccountSubscriptionBeforeDeletion(
      db,
      { PADDLE_API_KEY: "key" },
      "user",
    );

    expect(cancelSubscriptionMock).toHaveBeenCalledWith("key", "sub_user");
  });

  it("is idempotent after Paddle has scheduled cancellation", async () => {
    getSubscriptionMock.mockResolvedValue({
      id: "sub_user",
      customer_id: "ctm_user",
      status: "active",
      scheduled_change: { action: "cancel", effective_at: new Date().toISOString() },
      items: [],
      updated_at: new Date().toISOString(),
    });

    await cancelAccountSubscriptionBeforeDeletion(
      db,
      { PADDLE_API_KEY: "key" },
      "user",
    );

    expect(cancelSubscriptionMock).not.toHaveBeenCalled();
  });

  it("fails closed when the remote subscription belongs to another customer", async () => {
    getSubscriptionMock.mockResolvedValue({
      id: "sub_user",
      customer_id: "ctm_other",
      status: "active",
      scheduled_change: null,
      items: [],
      updated_at: new Date().toISOString(),
    });

    await expect(cancelAccountSubscriptionBeforeDeletion(
      db,
      { PADDLE_API_KEY: "key" },
      "user",
    )).rejects.toThrow("does not match");
    expect(cancelSubscriptionMock).not.toHaveBeenCalled();
  });

  it("cancels a second subscription that no local column projects", async () => {
    // The projected subscription is already handled at Paddle.
    getSubscriptionMock.mockResolvedValue(projectedSubscription({
      status: "canceled",
    }));
    // ...but a checkout that completed while the deletion was starting
    // created another one. Only a Paddle-side list can see it.
    stubSubscriptionList([
      { id: "sub_user", status: "canceled", customer_id: "ctm_user", scheduled_change: null },
      { id: "sub_extra", status: "active", customer_id: "ctm_user", scheduled_change: null },
    ]);

    await cancelAccountSubscriptionBeforeDeletion(db, { PADDLE_API_KEY: "key" }, "user");

    expect(cancelSubscriptionMock).toHaveBeenCalledTimes(1);
    expect(cancelSubscriptionMock).toHaveBeenCalledWith("key", "sub_extra");
  });

  it("cancels every still-billable subscription for the customer", async () => {
    getSubscriptionMock.mockResolvedValue(projectedSubscription());
    stubSubscriptionList([
      { id: "sub_user", status: "active", customer_id: "ctm_user", scheduled_change: null },
      { id: "sub_trial", status: "trialing", customer_id: "ctm_user", scheduled_change: null },
      { id: "sub_dunning", status: "past_due", customer_id: "ctm_user", scheduled_change: null },
    ]);

    await cancelAccountSubscriptionBeforeDeletion(db, { PADDLE_API_KEY: "key" }, "user");

    const canceled = cancelSubscriptionMock.mock.calls.map((call) => call[1]);
    expect(canceled.sort()).toEqual(["sub_dunning", "sub_trial", "sub_user"]);
  });

  it("skips subscriptions whose cancellation is already scheduled at Paddle", async () => {
    getSubscriptionMock.mockResolvedValue(projectedSubscription({
      status: "canceled",
    }));
    stubSubscriptionList([
      { id: "sub_scheduled", status: "active", customer_id: "ctm_user", scheduled_change: { action: "cancel" } },
    ]);

    await cancelAccountSubscriptionBeforeDeletion(db, { PADDLE_API_KEY: "key" }, "user");

    expect(cancelSubscriptionMock).not.toHaveBeenCalled();
  });

  it("follows Paddle's pagination so a page boundary cannot hide a live subscription", async () => {
    getSubscriptionMock.mockResolvedValue(projectedSubscription({
      status: "canceled",
    }));
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ id: "sub_page1", status: "active", customer_id: "ctm_user", scheduled_change: null }],
        // As Paddle sends it: the whole URL of the next page.
        meta: { pagination: { has_more: true, next: "https://api.paddle.com/subscriptions?after=sub_page1&customer_id=ctm_user&per_page=200" } },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ id: "sub_page2", status: "active", customer_id: "ctm_user", scheduled_change: null }],
        meta: { pagination: { has_more: false } },
      }), { status: 200 }));

    await cancelAccountSubscriptionBeforeDeletion(db, { PADDLE_API_KEY: "key" }, "user");

    const canceled = cancelSubscriptionMock.mock.calls.map((call) => call[1]);
    expect(canceled.sort()).toEqual(["sub_page1", "sub_page2"]);
    expect(fetchMock.mock.calls[1][0]).toBe(
      "https://api.paddle.com/subscriptions?after=sub_page1&customer_id=ctm_user&per_page=200",
    );
  });

  it("refuses to send the API key to a next page outside Paddle's API", async () => {
    getSubscriptionMock.mockResolvedValue(projectedSubscription({
      status: "canceled",
    }));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      data: [],
      meta: { pagination: { has_more: true, next: "https://elsewhere.example/subscriptions?after=x" } },
    }), { status: 200 }));

    await expect(
      cancelAccountSubscriptionBeforeDeletion(db, { PADDLE_API_KEY: "key" }, "user"),
    ).rejects.toThrow("left the API");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails the deletion when the customer's subscriptions cannot be listed", async () => {
    getSubscriptionMock.mockResolvedValue(projectedSubscription({
      status: "canceled",
    }));
    fetchMock.mockResolvedValue(new Response("boom", { status: 500 }));

    await expect(
      cancelAccountSubscriptionBeforeDeletion(db, { PADDLE_API_KEY: "key" }, "user"),
    ).rejects.toThrow("500");
    // The projected subscription was cancelled, but the deletion itself is
    // aborted by the throw — the marker stays and the sweep retries.
    expect(cancelSubscriptionMock).not.toHaveBeenCalled();
  });

  it("queries Paddle even when the local projection is empty but a customer exists", async () => {
    await db
      .update(users)
      .set({ paddleSubscriptionId: null, subscriptionStatus: null })
      .where((await import("drizzle-orm")).eq(users.id, "user"));
    stubSubscriptionList([
      { id: "sub_unprojected", status: "active", customer_id: "ctm_user", scheduled_change: null },
    ]);

    await cancelAccountSubscriptionBeforeDeletion(db, { PADDLE_API_KEY: "key" }, "user");

    expect(getSubscriptionMock).not.toHaveBeenCalled();
    expect(cancelSubscriptionMock).toHaveBeenCalledWith("key", "sub_unprojected");
  });

  it("does nothing for an account with no known billing relationship", async () => {
    await db
      .update(users)
      .set({ paddleCustomerId: null, paddleSubscriptionId: null, subscriptionStatus: null })
      .where((await import("drizzle-orm")).eq(users.id, "user"));

    await cancelAccountSubscriptionBeforeDeletion(db, { PADDLE_API_KEY: "key" }, "user");

    expect(getSubscriptionMock).not.toHaveBeenCalled();
    expect(cancelSubscriptionMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
