import { beforeEach, describe, expect, it, vi } from "vitest";
import { billingSubscriptions, organizationMembers, organizations, users } from "@orbmeet/db/schema";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "@/test/db";
import type { PolarSubscription } from "@/modules/billing/server/polar-schema";

const ORGANIZATION_PRODUCT = "22222222-2222-4222-8222-222222222222";

/** Polar's side of the Organization's subscription, as the mocks below serve it. */
const polar = vi.hoisted(() => ({
  seats: 1,
  pendingSeats: null as number | null,
  version: 0,
}));

function snapshot(): PolarSubscription {
  return {
    id: "sub_org_1",
    status: "active",
    product_id: ORGANIZATION_PRODUCT,
    seats: polar.seats,
    cancel_at_period_end: false,
    current_period_end: null,
    created_at: "2026-11-01T00:00:00Z",
    modified_at: new Date(Date.parse("2026-11-01T00:00:00Z") + polar.version * 1000).toISOString(),
    customer: { id: "cus_org", external_id: "org:org_1" },
    pending_update: polar.pendingSeats === null ? null : { seats: polar.pendingSeats },
  };
}

const getSubscriptionMock = vi.hoisted(() => vi.fn());
const updateSubscriptionSeatsMock = vi.hoisted(() => vi.fn());
vi.mock("@/modules/billing/server/polar", async (original) => ({
  ...await original<typeof import("@/modules/billing/server/polar")>(),
  getSubscription: getSubscriptionMock,
  updateSubscriptionSeats: updateSubscriptionSeatsMock,
}));

import { addOrganizationMember, removeOrganizationMember } from "./membership.server";
import { PolarApiError } from "@/modules/billing/server/polar";
import { syncOrganizationSeats } from "@/modules/billing/server/organization-seats.server";
import { seedSubscription } from "@/test/billing";

let db: TestDb;

const env = {
  POLAR_ACCESS_TOKEN: "test-token",
  POLAR_PRODUCT_ID_ORGANIZATION: ORGANIZATION_PRODUCT,
} as unknown as Env;

const invite = {
  kind: "addOrganizationMember" as const,
  organizationId: "org_1",
  actorUserId: "owner",
  email: "target@example.com",
  role: "member" as const,
};

async function insertUser(id: string) {
  const now = new Date();
  await db.insert(users).values({
    id,
    name: id,
    email: `${id}@example.com`,
    normalizedEmail: `${id}@example.com`,
    role: "user",
    createdAt: now,
    updatedAt: now,
  });
}

async function storedSeats() {
  const [row] = await db
    .select({ seats: billingSubscriptions.seats })
    .from(billingSubscriptions)
    .where(eq(billingSubscriptions.id, "sub_org_1"));
  return row?.seats;
}

beforeEach(async () => {
  db = await createTestDb();
  polar.seats = 1;
  polar.pendingSeats = null;
  polar.version = 0;
  getSubscriptionMock.mockReset().mockImplementation(async () => snapshot());
  updateSubscriptionSeatsMock.mockReset().mockImplementation(
    async (_client: unknown, _id: string, seats: number, proration: "invoice" | "next_period") => {
      if (proration === "invoice") {
        polar.seats = seats;
        polar.pendingSeats = null;
      } else {
        polar.pendingSeats = seats;
      }
      polar.version += 1;
      return snapshot();
    },
  );
  await insertUser("owner");
  await insertUser("target");
  const now = new Date();
  await db.insert(organizations).values({
    id: "org_1",
    name: "Acme",
    ownerId: "owner",
    createdAt: now,
    updatedAt: now,
  });
  // One paid seat, held by the owner.
  await seedSubscription(db, { organizationId: "org_1", seats: 1 }, { id: "sub_org_1" });
  await db.insert(organizationMembers).values({
    id: "omb_owner",
    organizationId: "org_1",
    userId: "owner",
    role: "admin",
    joinedAt: now,
  });
});

describe("addOrganizationMember", () => {
  it("buys the new member's seat, invoiced now, then adds them", async () => {
    await expect(addOrganizationMember(db, env, invite)).resolves.toEqual({ success: true });

    expect(updateSubscriptionSeatsMock).toHaveBeenCalledExactlyOnceWith(
      expect.anything(), "sub_org_1", 2, "invoice");
    expect(await storedSeats()).toBe(2);
    await expect(db.query.organizationMembers.findFirst({ where: { userId: "target" } }))
      .resolves.toMatchObject({ organizationId: "org_1", role: "member" });
  });

  it("uses a seat already bought when the membership failed the first time", async () => {
    const batch = vi.spyOn(db, "batch").mockRejectedValueOnce(new Error("D1 unavailable"));
    try {
      await expect(addOrganizationMember(db, env, invite)).rejects.toThrow("D1 unavailable");
    } finally {
      batch.mockRestore();
    }
    expect(await storedSeats()).toBe(2);
    await expect(db.query.organizationMembers.findFirst({ where: { userId: "target" } }))
      .resolves.toBeUndefined();

    await expect(addOrganizationMember(db, env, invite)).resolves.toEqual({ success: true });
    expect(updateSubscriptionSeatsMock).toHaveBeenCalledOnce();
    await expect(db.query.organizationMembers.findFirst({ where: { userId: "target" } }))
      .resolves.toMatchObject({ organizationId: "org_1" });
  });

  it.each([
    [402, "PaymentFailed", "payment method was declined"],
    [403, "AlreadyCanceledSubscription", "ending or not active"],
    [422, "AboveMaximumSeats", "allows no more seats"],
  ])("explains a %i seat refusal and adds no one", async (status, code, message) => {
    updateSubscriptionSeatsMock.mockRejectedValueOnce(new PolarApiError(status, code, "refused"));

    await expect(addOrganizationMember(db, env, invite))
      .rejects.toMatchObject({ code: "CONFLICT", message: expect.stringContaining(message) });
    expect(await storedSeats()).toBe(1);
    await expect(db.query.organizationMembers.findFirst({ where: { userId: "target" } }))
      .resolves.toBeUndefined();
  });

  it("adds no one to an Organization that is not subscribed", async () => {
    await db.update(billingSubscriptions).set({ status: "canceled" }).where(eq(billingSubscriptions.id, "sub_org_1"));

    await expect(addOrganizationMember(db, env, invite)).rejects.toMatchObject({ code: "PLAN_LIMIT_REACHED" });
    expect(updateSubscriptionSeatsMock).not.toHaveBeenCalled();
  });
});

describe("removeOrganizationMember", () => {
  it("gives the seat back from the next period", async () => {
    await addOrganizationMember(db, env, invite);
    updateSubscriptionSeatsMock.mockClear();

    await expect(removeOrganizationMember(db, env, {
      kind: "removeOrganizationMember",
      organizationId: "org_1",
      actorUserId: "owner",
      memberUserId: "target",
    })).resolves.toEqual({ success: true, removed: true });

    expect(updateSubscriptionSeatsMock).toHaveBeenCalledExactlyOnceWith(
      expect.anything(), "sub_org_1", 1, "next_period");
  });

  it("removes the member even when Polar cannot lower the seats now", async () => {
    await addOrganizationMember(db, env, invite);
    updateSubscriptionSeatsMock.mockRejectedValueOnce(new Error("Polar unavailable"));

    await expect(removeOrganizationMember(db, env, {
      kind: "removeOrganizationMember",
      organizationId: "org_1",
      actorUserId: "owner",
      memberUserId: "target",
    })).resolves.toEqual({ success: true, removed: true });
    await expect(db.query.organizationMembers.findFirst({ where: { userId: "target" } }))
      .resolves.toBeUndefined();
  });
});

describe("syncOrganizationSeats", () => {
  it.each(["BelowMinimumSeats", "SeatsAlreadyAssigned"])(
    "treats a decrease Polar refuses with %s as settled, not as a failure",
    async (code) => {
      polar.seats = 3;
      updateSubscriptionSeatsMock.mockRejectedValueOnce(new PolarApiError(422, code, "refused"));

      await expect(syncOrganizationSeats(db, env, "org_1")).resolves.toBeUndefined();
      expect(updateSubscriptionSeatsMock).toHaveBeenCalledExactlyOnceWith(
        expect.anything(), "sub_org_1", 1, "next_period");
      expect(await storedSeats()).toBe(3);
    },
  );
});
