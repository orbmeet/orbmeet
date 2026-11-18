import { beforeEach, describe, expect, it, vi } from "vitest";
import { billingSubscriptions, organizations, users } from "@orbmeet/db/schema";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "@/test/db";
import type { PolarSubscription } from "./polar-schema";

// The store is a projection: it must never call Polar.
const fetchMock = vi.hoisted(() => vi.fn());
vi.stubGlobal("fetch", fetchMock);

import { hasEnded, LIVE_POLAR_STATUSES, syncSubscription } from "./subscription-store.server";
import { loadOrganizationPlan, loadUserBilling } from "./entitlements.server";

const PRO = "11111111-1111-4111-8111-111111111111";
const ORGANIZATION = "22222222-2222-4222-8222-222222222222";
const env = {
  POLAR_ACCESS_TOKEN: "t",
  POLAR_PRODUCT_ID_PRO: PRO,
  POLAR_PRODUCT_ID_ORGANIZATION: ORGANIZATION,
};

let db: TestDb;

function subscription(overrides: Partial<PolarSubscription> = {}): PolarSubscription {
  return {
    id: "sub_1",
    status: "active",
    product_id: PRO,
    seats: null,
    cancel_at_period_end: false,
    current_period_end: "2026-12-01T00:00:00Z",
    created_at: "2026-11-01T00:00:00Z",
    modified_at: "2026-11-02T00:00:00Z",
    customer: { id: "cus_1", external_id: "user:ada" },
    pending_update: null,
    ...overrides,
  };
}

async function stored(id = "sub_1") {
  const [row] = await db.select().from(billingSubscriptions).where(eq(billingSubscriptions.id, id));
  return row;
}

beforeEach(async () => {
  db = await createTestDb();
  fetchMock.mockReset();
  const now = new Date();
  await db.insert(users).values({
    id: "ada", name: "Ada", email: "ada@example.com", normalizedEmail: "ada@example.com",
    role: "user", createdAt: now, updatedAt: now,
  });
  await db.insert(organizations).values({ id: "org_1", name: "Acme", ownerId: "ada", createdAt: now, updatedAt: now });
});

describe("syncSubscription", () => {
  it("stores a user's Pro subscription, and with it their plan", async () => {
    await syncSubscription(db, env, subscription());

    expect(await stored()).toMatchObject({ userId: "ada", organizationId: null, status: "active", seats: null });
    await expect(loadUserBilling(db, "ada")).resolves.toEqual({
      plan: "pro",
      subscriptionStatus: "active",
      hasManagedSubscription: true,
    });
  });

  it("stores an Organization's subscription with its seats", async () => {
    await syncSubscription(db, env, subscription({
      product_id: ORGANIZATION,
      seats: 4,
      customer: { id: "cus_2", external_id: "org:org_1" },
    }));

    expect(await stored()).toMatchObject({ userId: null, organizationId: "org_1", seats: 4 });
    await expect(loadOrganizationPlan(db, "org_1")).resolves.toBe("organization");
    // The owner's own plan is untouched by the Organization's.
    await expect(loadUserBilling(db, "ada")).resolves.toMatchObject({ plan: "free" });
  });

  it("never lets an older snapshot overwrite a newer one, in either order", async () => {
    await syncSubscription(db, env, subscription({ status: "canceled", modified_at: "2026-11-03T00:00:00Z" }));
    await syncSubscription(db, env, subscription({ status: "active", modified_at: "2026-11-02T00:00:00Z" }));

    expect(await stored()).toMatchObject({ status: "canceled" });
    await expect(loadUserBilling(db, "ada")).resolves.toEqual({
      plan: "free",
      subscriptionStatus: null,
      hasManagedSubscription: false,
    });
  });

  it.each([
    ["past_due", "pro", true],
    ["trialing", "pro", true],
    ["unpaid", "free", true],
    ["incomplete", "free", true],
    ["paused", "free", true],
    ["incomplete_expired", "free", false],
  ] as const)("a %s subscription leaves the user on %s", async (status, plan, managed) => {
    await syncSubscription(db, env, subscription({ status }));
    await expect(loadUserBilling(db, "ada")).resolves.toMatchObject({ plan, hasManagedSubscription: managed });
  });

  it("stores nothing for a product that is not the customer's plan", async () => {
    await syncSubscription(db, env, subscription({ product_id: ORGANIZATION }));
    expect(await stored()).toBeUndefined();
  });

  it("stores nothing for an Organization product without seats", async () => {
    await syncSubscription(db, env, subscription({
      product_id: ORGANIZATION,
      seats: null,
      customer: { id: "cus_2", external_id: "org:org_1" },
    }));
    expect(await stored()).toBeUndefined();
  });

  it("stores nothing, and calls Polar for nothing, for a customer billing did not create", async () => {
    await syncSubscription(db, env, subscription({ customer: { id: "cus_x", external_id: null } }));
    expect(await stored()).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("leaves a subscription whose customer does not exist here untouched, even a renewing one", async () => {
    // An erased account (closure already ended its subscriptions), or another
    // deployment's customer in the same Polar organization.
    await syncSubscription(db, env, subscription({ customer: { id: "cus_1", external_id: "user:elsewhere" } }));
    expect(await stored()).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps tracking an adopted subscription after its product changes, so its end lands", async () => {
    const LEGACY = "33333333-3333-4333-8333-333333333333";
    await syncSubscription(db, env, subscription());
    await syncSubscription(db, env, subscription({
      product_id: LEGACY,
      cancel_at_period_end: true,
      modified_at: "2026-11-03T00:00:00Z",
    }));
    expect(await stored()).toMatchObject({ status: "active", cancelAtPeriodEnd: true });

    await syncSubscription(db, env, subscription({
      product_id: LEGACY,
      status: "canceled",
      modified_at: "2026-11-04T00:00:00Z",
    }));
    expect(await stored()).toMatchObject({ status: "canceled" });
    await expect(loadUserBilling(db, "ada")).resolves.toMatchObject({ plan: "free", hasManagedSubscription: false });
  });

  it("keeps an Organization's seats when its new product carries none", async () => {
    const org = { id: "cus_2", external_id: "org:org_1" };
    await syncSubscription(db, env, subscription({ product_id: ORGANIZATION, seats: 4, customer: org }));
    await syncSubscription(db, env, subscription({
      product_id: PRO,
      seats: null,
      status: "past_due",
      customer: org,
      modified_at: "2026-11-03T00:00:00Z",
    }));
    expect(await stored()).toMatchObject({ status: "past_due", seats: 4 });
  });

  it("never lets an older snapshot of a product it would not adopt overwrite a newer one", async () => {
    await syncSubscription(db, env, subscription({ status: "canceled", modified_at: "2026-11-03T00:00:00Z" }));
    await syncSubscription(db, env, subscription({ product_id: ORGANIZATION, status: "active" }));
    expect(await stored()).toMatchObject({ status: "canceled" });
  });

  it("is removed with its customer", async () => {
    const now = new Date();
    await db.insert(users).values({
      id: "bea", name: "Bea", email: "bea@example.com", normalizedEmail: "bea@example.com",
      role: "user", createdAt: now, updatedAt: now,
    });
    await syncSubscription(db, env, subscription({ customer: { id: "cus_3", external_id: "user:bea" } }));
    expect(await stored()).toMatchObject({ userId: "bea" });

    await db.delete(users).where(eq(users.id, "bea"));
    expect(await stored()).toBeUndefined();
  });
});

describe("Polar statuses", () => {
  it("re-reads every status a subscription can still leave, and only those", () => {
    expect([...LIVE_POLAR_STATUSES].sort()).toEqual(["active", "incomplete", "past_due", "paused", "trialing", "unpaid"]);
  });

  it.each(["canceled", "incomplete_expired"])("treats %s as ended", (status) => {
    expect(hasEnded({ status })).toBe(true);
  });
});
