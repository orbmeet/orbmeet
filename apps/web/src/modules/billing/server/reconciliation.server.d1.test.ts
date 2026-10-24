import { beforeEach, describe, expect, it, vi } from "vitest";
import { organizationMembers, organizations, users } from "@orbmeet/db/schema";
import { sql } from "drizzle-orm";
import { createTestDb, type TestDb } from "@/test/db";

const getSubscriptionMock = vi.hoisted(() => vi.fn());
const updateSubscriptionQuantityMock = vi.hoisted(() => vi.fn());

vi.mock("@/modules/billing/server/paddle", () => ({
  getSubscription: getSubscriptionMock,
  updateSubscriptionQuantity: updateSubscriptionQuantityMock,
}));

import { reconcilePaddleSubscriptions } from "./reconciliation.server";

let db: TestDb;
const appDb = () => db;

beforeEach(async () => {
  db = await createTestDb();
  getSubscriptionMock.mockReset();
  updateSubscriptionQuantityMock.mockReset();
  const now = new Date();
  await db.insert(users).values([
    {
      id: "a_poison",
      name: "Poison",
      email: "poison@example.com",
      normalizedEmail: "poison@example.com",
      plan: "free",
      paddleSubscriptionId: "subscription-poison",
      role: "user",
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "b_healthy",
      name: "Healthy",
      email: "healthy@example.com",
      normalizedEmail: "healthy@example.com",
      plan: "free",
      paddleSubscriptionId: "subscription-healthy",
      role: "user",
      createdAt: now,
      updatedAt: now,
    },
  ]);
});

describe("Paddle reconciliation failure isolation", () => {
  it("reads legacy seconds and writes millisecond-precise billing timestamps", async () => {
    const eventTime = new Date("2026-07-29T00:10:00.123Z");
    await db.run(sql`
      update ${users}
      set subscription_updated_at = ${Math.floor(eventTime.getTime() / 1000)}
      where ${users.id} = 'b_healthy'
    `);
    await expect(db.query.users.findFirst({
      where: { id: "b_healthy" },
      columns: { subscriptionUpdatedAt: true },
    })).resolves.toEqual({
      subscriptionUpdatedAt: new Date("2026-07-29T00:10:00.000Z"),
    });

    await db.update(users)
      .set({ subscriptionUpdatedAt: eventTime })
      .where(sql`${users.id} = 'b_healthy'`);
    await expect(db.select({ value: sql<number>`${users.subscriptionUpdatedAt}` })
      .from(users)
      .where(sql`${users.id} = 'b_healthy'`))
      .resolves.toEqual([{ value: eventTime.getTime() }]);
  });

  it("continues past a poison subscription and reconciles later rows", async () => {
    getSubscriptionMock.mockImplementation(async (_apiKey: string, id: string) => {
      if (id === "subscription-poison") {
        return {
          id: "wrong-subscription",
          status: "active",
          items: [{ price: { id: "pri_01test0000000000000000pro" } }],
          customer_id: "customer-poison",
          updated_at: "2026-07-29T00:00:00.000Z",
        };
      }
      return {
        id,
        status: "active",
        items: [{ price: { id: "pri_01test0000000000000000pro" } }],
        customer_id: "customer-healthy",
        updated_at: "2026-07-29T00:00:00.000Z",
      };
    });

    await expect(reconcilePaddleSubscriptions(appDb(), {
      PADDLE_API_KEY: "test-key",
      PADDLE_PRICE_ID_PRO: "pri_01test0000000000000000pro",
      PADDLE_PRICE_ID_ORG_SEAT: "pri_01test000000000000000seat",
    } as unknown as Env)).rejects.toThrow("Paddle reconciliation completed with row failures");

    await expect(db.query.users.findFirst({
      where: { id: "b_healthy" },
    })).resolves.toMatchObject({
      plan: "pro",
      paddleCustomerId: "customer-healthy",
      subscriptionStatus: "active",
    });
  });

  it("does not overwrite a newer webhook projection with an older API snapshot", async () => {
    const newerWebhookAt = new Date("2026-07-29T00:10:00.000Z");
    await db
      .update(users)
      .set({
        plan: "free",
        subscriptionStatus: "canceled",
        subscriptionUpdatedAt: newerWebhookAt,
      })
      .where(sql`1 = 1`);
    getSubscriptionMock.mockImplementation(async (_apiKey: string, id: string) => ({
      id,
      status: "active",
      items: [{ price: { id: "pri_01test0000000000000000pro" } }],
      customer_id: `customer-${id}`,
      updated_at: "2026-07-29T00:05:00.000Z",
    }));

    await reconcilePaddleSubscriptions(appDb(), {
      PADDLE_API_KEY: "test-key",
      PADDLE_PRICE_ID_PRO: "pri_01test0000000000000000pro",
      PADDLE_PRICE_ID_ORG_SEAT: "pri_01test000000000000000seat",
    } as unknown as Env, new Date("2026-07-29T00:20:00.000Z"));

    await expect(db.query.users.findFirst({ where: { id: "b_healthy" } }))
      .resolves.toMatchObject({
        plan: "free",
        subscriptionStatus: "canceled",
        subscriptionUpdatedAt: newerWebhookAt,
      });
  });

  it("preserves purchased Organization headroom beyond current membership", async () => {
    const now = new Date();
    await db.insert(organizations).values({
      id: "org_healthy",
      name: "Healthy Organization",
      ownerId: "b_healthy",
      plan: "organization",
      paddleSubscriptionId: "subscription-healthy",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(organizationMembers).values({
      id: "org_member_owner",
      organizationId: "org_healthy",
      userId: "b_healthy",
      role: "admin",
      joinedAt: now,
    });
    getSubscriptionMock.mockImplementation(async (_apiKey: string, id: string) => ({
      id,
      status: "active",
      items: [{ price: { id: "pri_01test000000000000000seat" }, quantity: 4 }],
      customer_id: `customer-${id}`,
      updated_at: "2026-07-29T00:05:00.000Z",
    }));

    await reconcilePaddleSubscriptions(appDb(), {
      PADDLE_API_KEY: "test-key",
      PADDLE_PRICE_ID_PRO: "pri_01test0000000000000000pro",
      PADDLE_PRICE_ID_ORG_SEAT: "pri_01test000000000000000seat",
    } as unknown as Env);

    expect(updateSubscriptionQuantityMock).not.toHaveBeenCalled();
    expect(await db.query.organizations.findFirst({ where: { id: "org_healthy" } }))
      .toMatchObject({ licenseLimit: 4 });
  });
});
