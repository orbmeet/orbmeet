import { beforeEach, describe, expect, it } from "vitest";
import { billingSubscriptions, organizationMembers, organizations, spaces, users } from "@orbmeet/db/schema";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "@/test/db";
import { assertOrganizationRole } from "./authority.server";
import { insertOrganizationMemberByEmail, listOrganizationMembersImpl } from "./membership.server";
import type { AuthFnContext } from "@/app/bootstrap/middleware";
import { selectOrganizationSpaces, selectOrganizationsForUser } from "./organizations.server";
import { seedSubscription } from "@/test/billing";

let db: TestDb;
const appDb = () => db;

beforeEach(async () => {
  db = await createTestDb();
});

async function insertUser(id: string) {
  const now = new Date();
  await db.insert(users).values({
    id,
    name: id,
    email: `${id}@example.com`,
    normalizedEmail: `${id}@example.com`,
    image: null,
    role: "user",
    createdAt: now,
    updatedAt: now,
  });
}

async function insertOrganization(seats = 25) {
  const now = new Date();
  await db.insert(organizations).values({
    id: "org_1",
    name: "Acme",
    ownerId: "owner",
    createdAt: now,
    updatedAt: now,
  });
  await seedSubscription(db, { organizationId: "org_1", seats });
}

describe("organization authority", () => {
  it("derives owner role from organizations.ownerId", async () => {
    await insertUser("owner");
    await insertOrganization();

    await expect(assertOrganizationRole(appDb(), "org_1", "owner", "owner")).resolves.toMatchObject({
      role: "owner",
      userId: "owner",
    });

    await expect(selectOrganizationsForUser(appDb(), "owner")).resolves.toMatchObject([
      { id: "org_1", role: "owner" },
    ]);
  });

  it("keeps delegated admin membership separate from ownership", async () => {
    await insertUser("owner");
    await insertUser("admin");
    await insertOrganization();
    await db.insert(organizationMembers).values({
      id: "omb_admin",
      organizationId: "org_1",
      userId: "admin",
      role: "admin",
      joinedAt: new Date(),
    });

    await expect(assertOrganizationRole(appDb(), "org_1", "admin", "admin")).resolves.toMatchObject({
      role: "admin",
      userId: "admin",
    });
    await expect(assertOrganizationRole(appDb(), "org_1", "admin", "owner")).rejects.toThrow();
  });

  it("lists governed Spaces without granting their content membership", async () => {
    await insertUser("owner");
    await insertOrganization();
    const now = new Date();
    await db.insert(spaces).values({
      kind: "shared",
      id: "spc_1",
      name: "Class A",
      slug: "class-a",
      ownerUserId: null,
      organizationId: "org_1",
      createdAt: now,
      updatedAt: now,
    });
    await expect(selectOrganizationSpaces(appDb(), "org_1", "owner")).resolves.toEqual([
      expect.objectContaining({
        id: "spc_1",
        memberCount: 0,
        viewerRole: null,
      }),
    ]);
  });
});

describe("insertOrganizationMemberByEmail", () => {
  it("inserts a registered account without first disclosing its identity", async () => {
    await insertUser("owner");
    await insertUser("target");
    await insertOrganization();

    await expect(insertOrganizationMemberByEmail(appDb(), {
      organizationId: "org_1",
      normalizedEmail: "target@example.com",
      membershipId: "omb_target",
      role: "member",
      joinedAt: new Date(),
    })).resolves.toBe(true);

    await expect(
      db.query.organizationMembers.findFirst({ where: { id: "omb_target" } }),
    ).resolves.toMatchObject({ userId: "target", role: "member" });
  });

  it("returns the same result for an unknown email and an existing member", async () => {
    await insertUser("owner");
    await insertUser("target");
    await insertOrganization();
    await db.insert(organizationMembers).values({
      id: "omb_target",
      organizationId: "org_1",
      userId: "target",
      role: "member",
      joinedAt: new Date(),
    });

    const base = {
      organizationId: "org_1",
      role: "member" as const,
      joinedAt: new Date(),
    };
    await expect(insertOrganizationMemberByEmail(appDb(), {
      ...base,
      normalizedEmail: "missing@example.com",
      membershipId: "omb_missing",
    })).resolves.toBe(false);
    await expect(insertOrganizationMemberByEmail(appDb(), {
      ...base,
      normalizedEmail: "target@example.com",
      membershipId: "omb_duplicate",
    })).resolves.toBe(false);
  });

  it("admits no one beyond the paid seats, inside the insert", async () => {
    await insertUser("owner");
    await insertUser("target");
    await insertOrganization(1);
    await db.insert(organizationMembers).values({
      id: "omb_owner",
      organizationId: "org_1",
      userId: "owner",
      role: "admin",
      joinedAt: new Date(),
    });

    await expect(insertOrganizationMemberByEmail(appDb(), {
      organizationId: "org_1",
      normalizedEmail: "target@example.com",
      membershipId: "omb_target",
      role: "member",
      joinedAt: new Date(),
    })).resolves.toBe(false);
    await expect(
      db.query.organizationMembers.findFirst({ where: { id: "omb_target" } }),
    ).resolves.toBeUndefined();
  });
});

it("holds the invitation boundary exactly at the paid seats", async () => {
  await insertUser("owner");
  await insertUser("member");
  await insertUser("outsider");
  await insertOrganization(2);
  await db.insert(organizationMembers).values([
    { id: "omb_owner", organizationId: "org_1", userId: "owner", role: "admin", joinedAt: new Date() },
    { id: "omb_member", organizationId: "org_1", userId: "member", role: "member", joinedAt: new Date() },
  ]);
  const invite = {
    organizationId: "org_1", normalizedEmail: "outsider@example.com", membershipId: "omb_outsider",
    role: "member" as const, joinedAt: new Date(), actorUserId: "owner",
  };

  expect(await insertOrganizationMemberByEmail(db, invite)).toBe(false);
  // Only once the third seat is bought does the invitation go through.
  await db.update(billingSubscriptions).set({ seats: 3 }).where(eq(billingSubscriptions.organizationId, "org_1"));
  expect(await insertOrganizationMemberByEmail(db, invite)).toBe(true);
});

it.each(["unpaid", "incomplete", "paused", "canceled"] as const)(
  "admits no one while the subscription is %s, spare seats or not",
  async (status) => {
    await insertUser("owner"); await insertUser("target"); await insertOrganization();
    await db.update(billingSubscriptions).set({ status }).where(eq(billingSubscriptions.organizationId, "org_1"));
    expect(await insertOrganizationMemberByEmail(db, {
      organizationId: "org_1", normalizedEmail: "target@example.com", membershipId: "target_member",
      role: "member", joinedAt: new Date(), actorUserId: "owner",
    })).toBe(false);
  },
);

it("keeps admitting members while a renewal payment is retried (past_due)", async () => {
  await insertUser("owner"); await insertUser("target"); await insertOrganization();
  await db.update(billingSubscriptions).set({ status: "past_due" }).where(eq(billingSubscriptions.organizationId, "org_1"));
  expect(await insertOrganizationMemberByEmail(db, {
    organizationId: "org_1", normalizedEmail: "target@example.com", membershipId: "target_member",
    role: "member", joinedAt: new Date(), actorUserId: "owner",
  })).toBe(true);
});

it("checks actor authority in the insertion statement", async () => {
  await insertUser("owner"); await insertUser("target"); await insertUser("former_admin"); await insertOrganization();
  expect(await insertOrganizationMemberByEmail(db, {
    organizationId: "org_1", normalizedEmail: "target@example.com", membershipId: "target_member",
    role: "member", joinedAt: new Date(), actorUserId: "former_admin",
  })).toBe(false);
});

describe("organization roster pages", () => {
  async function seedRoster() {
    for (const id of ["owner", "ada", "bob", "cy", "dee"]) await insertUser(id);
    await insertOrganization();
    for (const id of ["owner", "ada", "bob", "cy", "dee"]) {
      await db.insert(organizationMembers).values({
        id: `omb_${id}`,
        organizationId: "org_1",
        userId: id,
        role: "member",
        joinedAt: new Date(),
      });
    }
  }
  const list = (cursor?: string) =>
    listOrganizationMembersImpl({
      data: { organizationId: "org_1", limit: 2, cursor },
      context: { user: { id: "owner" }, db } as unknown as AuthFnContext,
    });
  const names = (page: Awaited<ReturnType<typeof list>>) => page.members.map((member) => member.userId);

  it("does not skip anyone when a member on an earlier page leaves", async () => {
    await seedRoster();
    const first = await list();
    expect(names(first)).toEqual(["owner", "ada"]);

    await db.delete(organizationMembers).where(eq(organizationMembers.id, "omb_ada"));

    const second = await list(first.nextCursor);
    expect(names(second)).toEqual(["bob", "cy"]);
    expect(names(await list(second.nextCursor))).toEqual(["dee"]);
  });

  it("refuses a cursor it did not issue", async () => {
    await seedRoster();
    await expect(list("2")).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});
