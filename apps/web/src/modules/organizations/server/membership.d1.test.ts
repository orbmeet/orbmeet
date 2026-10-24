import { beforeEach, describe, expect, it, vi } from "vitest";
import { organizationMembers, organizations, users } from "@orbmeet/db/schema";
import { createTestDb, type TestDb } from "@/test/db";

const updateSubscriptionQuantityMock = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@/modules/billing/server/paddle", () => ({
  updateSubscriptionQuantity: updateSubscriptionQuantityMock,
}));

import { addOrganizationMember } from "./membership.server";

let db: TestDb;

const env = {
  PADDLE_API_KEY: "test-key",
  PADDLE_PRICE_ID_ORG_SEAT: "pri_01test000000000000000seat",
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
    plan: "organization",
    role: "user",
    createdAt: now,
    updatedAt: now,
  });
}

beforeEach(async () => {
  db = await createTestDb();
  updateSubscriptionQuantityMock.mockClear();
  await insertUser("owner");
  await insertUser("target");
  const now = new Date();
  // Every seat is taken: one paid, one member.
  await db.insert(organizations).values({
    id: "org_1",
    name: "Acme",
    ownerId: "owner",
    plan: "organization",
    licenseLimit: 1,
    subscriptionStatus: "active",
    paddleSubscriptionId: "sub_org",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(organizationMembers).values({
    id: "omb_owner",
    organizationId: "org_1",
    userId: "owner",
    role: "admin",
    joinedAt: now,
  });
});

async function licenseLimit() {
  return (await db.query.organizations.findFirst({ where: { id: "org_1" } }))?.licenseLimit;
}

describe("addOrganizationMember", () => {
  it("buys a seat when every one is taken, then adds the member", async () => {
    await expect(addOrganizationMember(db, env, invite)).resolves.toEqual({ success: true });

    expect(updateSubscriptionQuantityMock).toHaveBeenCalledExactlyOnceWith(
      "test-key", "sub_org", "pri_01test000000000000000seat", 2);
    expect(await licenseLimit()).toBe(2);
    await expect(db.query.organizationMembers.findFirst({ where: { userId: "target" } }))
      .resolves.toMatchObject({ organizationId: "org_1", role: "member" });
  });

  it("keeps the bought seat as headroom when the membership then fails", async () => {
    const batch = vi.spyOn(db, "batch").mockRejectedValueOnce(new Error("D1 unavailable"));
    try {
      await expect(addOrganizationMember(db, env, invite)).rejects.toThrow("D1 unavailable");
    } finally {
      batch.mockRestore();
    }

    // Nothing is given back: the seat is paid for and the ceiling says so.
    expect(updateSubscriptionQuantityMock).toHaveBeenCalledOnce();
    expect(await licenseLimit()).toBe(2);
    await expect(db.query.organizationMembers.findFirst({ where: { userId: "target" } }))
      .resolves.toBeUndefined();

    // The retry uses the headroom instead of buying another seat.
    await expect(addOrganizationMember(db, env, invite)).resolves.toEqual({ success: true });
    expect(updateSubscriptionQuantityMock).toHaveBeenCalledOnce();
    await expect(db.query.organizationMembers.findFirst({ where: { userId: "target" } }))
      .resolves.toMatchObject({ organizationId: "org_1" });
  });
});
