import { beforeEach, expect, it, vi } from "vitest";
import { organizations, users } from "@orbmeet/db/schema";
import { createTestDb, type TestDb } from "@/test/db";

const paddle = vi.hoisted(() => ({
  cancelSubscription: vi.fn().mockResolvedValue(undefined),
  getSubscription: vi.fn().mockResolvedValue({ status: "active" }),
}));
vi.mock("@/modules/billing/server/paddle", async (original) => ({
  ...await original<typeof import("@/modules/billing/server/paddle")>(), ...paddle,
}));
import { handlePaddleEvent } from "@/modules/billing/server/paddle-webhook.server";
import type { ParsedPaddleEvent } from "./paddle-subscription";
let db: TestDb;
const env = { PADDLE_API_KEY: "test", PADDLE_PRICE_ID_PRO: "pri_01test0000000000000000pro" } as unknown as Env;
beforeEach(async () => {
  db = await createTestDb();
  vi.clearAllMocks();
  await db.insert(users).values({ id: "owner", name: "Owner", email: "owner@example.com",
    normalizedEmail: "owner@example.com", paddleCustomerId: "customer", createdAt: new Date(), updatedAt: new Date() });
});
function event(id: string, second: number): ParsedPaddleEvent {
  return { kind: "subscription-upsert", eventType: "subscription.created",
    occurredAt: `2026-09-07T00:00:0${second}.123Z`,
    data: { id, customer_id: "customer", status: "active", items: [{ price: { id: "pri_01test0000000000000000pro" }, quantity: 1 }] } };
}
it("converges concurrent distinct subscriptions to one billed subscription", async () => {
  const events = [event("sub_a", 1), event("sub_b", 2)];
  const results = await Promise.allSettled(events.map((value) => handlePaddleEvent(db, value, env)));
  for (let i = 0; i < results.length; i++) {
    if (results[i].status === "rejected") await handlePaddleEvent(db, events[i], env);
  }
  const winner = await db.query.users.findFirst({ where: { id: "owner" } });
  const loser = winner!.paddleSubscriptionId === "sub_a" ? "sub_b" : "sub_a";
  expect(paddle.cancelSubscription).toHaveBeenCalledWith("test", loser, "immediately");
  expect(winner!.paddleSubscriptionId).toMatch(/^sub_[ab]$/);
});
it("an effective cancellation downgrades even if scheduled_change is retained in the payload", async () => {
  await handlePaddleEvent(db, event("sub_a", 1), env);
  await handlePaddleEvent(db, { kind: "subscription-canceled", eventType: "subscription.canceled",
    occurredAt: "2026-09-07T00:00:03.123Z", data: { id: "sub_a",
      scheduled_change: { action: "cancel", effective_at: "2026-09-07T00:00:03Z" } } }, env);
  expect(await db.query.users.findFirst({ where: { id: "owner" } }))
    .toMatchObject({ plan: "free", paddleSubscriptionId: null, subscriptionStatus: "canceled" });
});

// An erased account, or an ownership transfer, can leave the organizations row
// holding a subscription no user row points at any more. The cancellation used
// to return early on the missing user and leave that organization on a paid
// plan with its purchased seat ceiling forever.
it("downgrades an organization whose owner no longer holds the subscription", async () => {
  await db.insert(organizations).values({
    id: "org_orphan",
    name: "Orphan",
    ownerId: "owner",
    plan: "organization",
    paddleCustomerId: "customer",
    paddleSubscriptionId: "sub_orphan",
    subscriptionStatus: "active",
    licenseLimit: 12,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  await handlePaddleEvent(db, {
    kind: "subscription-canceled",
    eventType: "subscription.canceled",
    occurredAt: "2026-09-07T00:00:05.123Z",
    data: { id: "sub_orphan", scheduled_change: null },
  }, env);

  expect(await db.query.organizations.findFirst({ where: { id: "org_orphan" } }))
    .toMatchObject({
      plan: "free",
      subscriptionStatus: "canceled",
      paddleSubscriptionId: null,
      licenseLimit: 1,
    });
});

// Retrying cannot make an unrecognized status recognizable, so the event is
// acknowledged and the projection is left exactly as it was.
it("leaves the projection untouched for a status this build does not model", async () => {
  await handlePaddleEvent(db, event("sub_known", 1), env);

  await expect(handlePaddleEvent(db, {
    kind: "subscription-upsert",
    eventType: "subscription.updated",
    occurredAt: "2026-09-07T00:00:09.123Z",
    data: {
      id: "sub_known",
      customer_id: "customer",
      status: "some_future_status",
      items: [{ price: { id: "pri_01test0000000000000000pro" }, quantity: 1 }],
    },
  }, env)).resolves.toBeUndefined();

  expect(await db.query.users.findFirst({ where: { id: "owner" } }))
    .toMatchObject({ plan: "pro", paddleSubscriptionId: "sub_known", subscriptionStatus: "active" });
});

// An account can be erased while a checkout it started is still completing at
// Paddle: the resulting subscription event then arrives for a customer with no
// user row. Acknowledging that event silently used to leave a live contract
// billing an account that no longer exists.
it("cancels a subscription event for a customer whose account was erased", async () => {
  paddle.getSubscription.mockResolvedValue({
    id: "sub_erased",
    customer_id: "customer_erased",
    status: "active",
    scheduled_change: null,
  });

  await expect(handlePaddleEvent(db, {
    kind: "subscription-upsert",
    eventType: "subscription.created",
    occurredAt: "2026-09-07T00:00:06.123Z",
    data: {
      id: "sub_erased",
      customer_id: "customer_erased",
      status: "active",
      items: [{ price: { id: "pri_01test0000000000000000pro" }, quantity: 1 }],
    },
  }, env)).resolves.toBeUndefined();

  expect(paddle.cancelSubscription).toHaveBeenCalledWith("test", "sub_erased", "immediately");
});

it("is idempotent when the orphaned subscription is already canceled at Paddle", async () => {
  paddle.getSubscription.mockResolvedValue({
    id: "sub_erased",
    customer_id: "customer_erased",
    status: "canceled",
    scheduled_change: null,
  });

  await expect(handlePaddleEvent(db, {
    kind: "subscription-upsert",
    eventType: "subscription.updated",
    occurredAt: "2026-09-07T00:00:06.123Z",
    data: {
      id: "sub_erased",
      customer_id: "customer_erased",
      status: "active",
      items: [{ price: { id: "pri_01test0000000000000000pro" }, quantity: 1 }],
    },
  }, env)).resolves.toBeUndefined();

  expect(paddle.cancelSubscription).not.toHaveBeenCalled();
});

// The absence of a local row is evidence about our projection, never about who
// owns the subscription. If Paddle says this subscription belongs to somebody
// else, the premise of the erased-account branch is false and cancelling would
// destroy a stranger's live contract — with the ack meaning no redelivery ever
// revisits it.
it("cancels nothing when Paddle reports a different customer for the subscription", async () => {
  paddle.getSubscription.mockResolvedValue({
    id: "sub_erased",
    customer_id: "somebody_else",
    status: "active",
    scheduled_change: null,
  });

  await expect(handlePaddleEvent(db, {
    kind: "subscription-upsert",
    eventType: "subscription.created",
    occurredAt: "2026-09-07T00:00:06.123Z",
    data: {
      id: "sub_erased",
      customer_id: "customer_erased",
      status: "active",
      items: [{ price: { id: "pri_01test0000000000000000pro" }, quantity: 1 }],
    },
  }, env)).resolves.toBeUndefined();

  expect(paddle.cancelSubscription).not.toHaveBeenCalled();
});

it("keeps a subscription alive when an organization holds the customer after a transfer", async () => {
  await db.insert(organizations).values({
    id: "org_transferred",
    name: "Transferred",
    ownerId: "owner",
    plan: "organization",
    paddleCustomerId: "customer_transferred",
    paddleSubscriptionId: "sub_transferred",
    subscriptionStatus: "active",
    licenseLimit: 5,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  await expect(handlePaddleEvent(db, {
    kind: "subscription-upsert",
    eventType: "subscription.updated",
    occurredAt: "2026-09-07T00:00:07.123Z",
    data: {
      id: "sub_transferred",
      customer_id: "customer_transferred",
      status: "active",
      items: [{ price: { id: "pri_01test0000000000000000pro" }, quantity: 5 }],
    },
  }, env)).resolves.toBeUndefined();

  expect(paddle.cancelSubscription).not.toHaveBeenCalled();
});
