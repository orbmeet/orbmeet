import { beforeEach, describe, expect, it, vi } from "vitest";
import { billingSubscriptions, organizationMembers, organizations, users } from "@orbmeet/db/schema";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "@/test/db";
import { seedSubscription } from "@/test/billing";
import type { PolarSubscription } from "./polar-schema";

const listSubscriptionsByStatusMock = vi.hoisted(() => vi.fn());
const getSubscriptionMock = vi.hoisted(() => vi.fn());
vi.mock("./polar", async (original) => ({
  ...await original<typeof import("./polar")>(),
  listSubscriptionsByStatus: listSubscriptionsByStatusMock,
  getSubscription: getSubscriptionMock,
}));
const runSeriallyMock = vi.hoisted(() => vi.fn(async () => null));
vi.mock("@/app/serial/serial", () => ({ runSerially: runSeriallyMock }));

import { reconcileSubscriptions } from "./reconciliation.server";
import { LIVE_POLAR_STATUSES } from "./subscription-store.server";

const PRO = "11111111-1111-4111-8111-111111111111";
const ORGANIZATION = "22222222-2222-4222-8222-222222222222";
const env = {
  POLAR_ACCESS_TOKEN: "t",
  POLAR_PRODUCT_ID_PRO: PRO,
  POLAR_PRODUCT_ID_ORGANIZATION: ORGANIZATION,
} as unknown as Env;

let db: TestDb;

function subscription(overrides: Partial<PolarSubscription>): PolarSubscription {
  return {
    id: "sub",
    status: "active",
    product_id: PRO,
    seats: null,
    cancel_at_period_end: false,
    current_period_end: null,
    created_at: "2026-11-01T00:00:00Z",
    modified_at: "2026-11-10T00:00:00Z",
    customer: { id: "cus", external_id: "user:ada" },
    pending_update: null,
    ...overrides,
  };
}

async function status(id: string) {
  const [row] = await db.select({ status: billingSubscriptions.status }).from(billingSubscriptions)
    .where(eq(billingSubscriptions.id, id));
  return row?.status;
}

beforeEach(async () => {
  db = await createTestDb();
  listSubscriptionsByStatusMock.mockReset();
  getSubscriptionMock.mockReset();
  runSeriallyMock.mockClear();
  const now = new Date();
  await db.insert(users).values([
    { id: "ada", name: "Ada", email: "ada@example.com", normalizedEmail: "ada@example.com", role: "user", createdAt: now, updatedAt: now },
    { id: "bob", name: "Bob", email: "bob@example.com", normalizedEmail: "bob@example.com", role: "user", createdAt: now, updatedAt: now },
  ]);
  await db.insert(organizations).values({ id: "org_1", name: "Acme", ownerId: "ada", createdAt: now, updatedAt: now });
  await db.insert(organizationMembers).values([
    { id: "omb_ada", organizationId: "org_1", userId: "ada", role: "admin", joinedAt: now },
    { id: "omb_bob", organizationId: "org_1", userId: "bob", role: "member", joinedAt: now },
  ]);
});

describe("reconcileSubscriptions", () => {
  it("lands a subscription whose webhook never arrived", async () => {
    listSubscriptionsByStatusMock.mockResolvedValueOnce({
      subscriptions: [subscription({ id: "sub_ada" })],
      lastPage: true,
    });

    await expect(reconcileSubscriptions(db, env)).resolves.toBe(1);
    expect(await status("sub_ada")).toBe("active");
  });

  it("reads every page", async () => {
    listSubscriptionsByStatusMock
      .mockResolvedValueOnce({ subscriptions: [subscription({ id: "sub_ada" })], lastPage: false })
      .mockResolvedValueOnce({
        subscriptions: [subscription({ id: "sub_bob", customer: { id: "cus_b", external_id: "user:bob" } })],
        lastPage: true,
      });

    await expect(reconcileSubscriptions(db, env)).resolves.toBe(2);
    expect(listSubscriptionsByStatusMock).toHaveBeenNthCalledWith(2, expect.anything(), LIVE_POLAR_STATUSES, 2);
    expect(await status("sub_bob")).toBe("active");
  });

  it("re-reads a running subscription Polar no longer lists, so a missed end lands", async () => {
    await seedSubscription(db, { userId: "ada" }, { id: "sub_ended" });
    listSubscriptionsByStatusMock.mockResolvedValueOnce({ subscriptions: [], lastPage: true });
    getSubscriptionMock.mockResolvedValueOnce(subscription({ id: "sub_ended", status: "canceled" }));

    await reconcileSubscriptions(db, env);
    expect(getSubscriptionMock).toHaveBeenCalledWith(expect.anything(), "sub_ended");
    expect(await status("sub_ended")).toBe("canceled");
  });

  it("changes nothing when Polar has never heard of a stored subscription", async () => {
    await seedSubscription(db, { userId: "ada" }, { id: "sub_elsewhere" });
    listSubscriptionsByStatusMock.mockResolvedValueOnce({ subscriptions: [], lastPage: true });
    getSubscriptionMock.mockResolvedValueOnce(null);

    await reconcileSubscriptions(db, env);
    expect(await status("sub_elsewhere")).toBe("active");
  });

  it("queues a seat correction for an Organization whose seats differ from its members", async () => {
    listSubscriptionsByStatusMock.mockResolvedValueOnce({
      subscriptions: [subscription({
        id: "sub_org",
        product_id: ORGANIZATION,
        seats: 5,
        customer: { id: "cus_org", external_id: "org:org_1" },
      })],
      lastPage: true,
    });

    await reconcileSubscriptions(db, env);
    expect(runSeriallyMock).toHaveBeenCalledExactlyOnceWith(env, { kind: "syncOrganizationSeats", organizationId: "org_1" });
  });

  it("leaves an Organization alone when its seats already match", async () => {
    listSubscriptionsByStatusMock.mockResolvedValueOnce({
      subscriptions: [subscription({
        id: "sub_org",
        product_id: ORGANIZATION,
        seats: 2,
        customer: { id: "cus_org", external_id: "org:org_1" },
      })],
      lastPage: true,
    });

    await reconcileSubscriptions(db, env);
    expect(runSeriallyMock).not.toHaveBeenCalled();
  });

  it("finishes the pass and then reports what failed", async () => {
    await seedSubscription(db, { userId: "ada" }, { id: "sub_a" });
    await seedSubscription(db, { userId: "bob" }, { id: "sub_b" });
    listSubscriptionsByStatusMock.mockResolvedValueOnce({ subscriptions: [], lastPage: true });
    getSubscriptionMock
      .mockRejectedValueOnce(new Error("Polar unavailable"))
      .mockResolvedValueOnce(subscription({ id: "sub_b", status: "canceled", customer: { id: "c", external_id: "user:bob" } }));

    await expect(reconcileSubscriptions(db, env)).rejects.toBeInstanceOf(AggregateError);
    expect(getSubscriptionMock).toHaveBeenCalledTimes(2);
  });
});
