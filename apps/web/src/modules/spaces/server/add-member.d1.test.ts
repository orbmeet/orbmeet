import { beforeEach, describe, expect, it } from "vitest";
import { organizationMembers, organizations, spaces, spaceMembers, users } from "@orbmeet/db/schema";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "@/test/db";
import { PLAN_LIMITS } from "@/modules/billing/contract/plan-limits";
import {insertSpaceMemberWithinCap} from "@/modules/spaces/server/membership.server";

const FREE_CAP = PLAN_LIMITS.free.maxMembersPerSpace!;

let db: TestDb;
const getAppDb = () => db;

beforeEach(async () => {
  db = await createTestDb();
});

async function insertUser(id: string, plan: "free" | "pro" = "free") {
  const now = new Date();
  await db.insert(users).values({
    id,
    name: id,
    email: `${id}@example.com`,
    normalizedEmail: `${id}@example.com`,
    image: null,
    plan,
    role: "user",
    createdAt: now,
    updatedAt: now,
  });
}

async function insertSpace(id: string, ownerUserId: string) {
  const now = new Date();
  await db.insert(spaces).values({
    kind: "shared",
    id,
    slug: `${id}-slug`,
    name: "Test Space",
    description: null,
    ownerUserId,
    createdAt: now,
    updatedAt: now,
  });
}

async function insertMember(
  id: string,
  spaceId: string,
  userId: string,
  role: "owner" | "admin" | "member",
) {
  await db.insert(spaceMembers).values({
    id,
    spaceId,
    userId,
    // An owner is named on the Space and stored as an admin member.
    role: role === "owner" ? "admin" : role,
    joinedAt: new Date(),
  });
}

/** Add plain members until `spaceId` has `total` members. */
async function fillSpace(spaceId: string, total: number) {
  const existing = await db.$count(spaceMembers, eq(spaceMembers.spaceId, spaceId));
  for (let index = existing; index < total; index++) {
    await insertUser(`filler_${index}`);
    await insertMember(`mbr_filler_${index}`, spaceId, `filler_${index}`, "member");
  }
}

describe("insertSpaceMemberWithinCap", () => {
  it("adds a member and touches the space when a capped seat is available", async () => {
    await insertUser("owner");
    await insertUser("target");
    await insertSpace("spc_1", "owner");
    await insertMember("mbr_owner", "spc_1", "owner", "owner");

    const before = await db.query.spaces.findFirst({ where: { id: "spc_1" } });
    const now = new Date((before?.updatedAt?.getTime() ?? Date.now()) + 1000);

    await expect(
      insertSpaceMemberWithinCap(getAppDb(), {
        spaceId: "spc_1",
        userId: "target",
        memberId: "mbr_target",
        role: "member",
        now,
        actorUserId: "owner",
      }),
    ).resolves.toBe("inserted");

    await expect(
      db.query.spaceMembers.findFirst({ where: { id: "mbr_target" } }),
    ).resolves.toMatchObject({ userId: "target", role: "member" });
    await expect(
      db.query.spaces.findFirst({ where: { id: "spc_1" } }),
    ).resolves.toMatchObject({ updatedAt: now });
  });

  it("does not add an account whose deletion has begun", async () => {
    await insertUser("owner");
    await insertUser("target");
    await insertSpace("spc_1", "owner");
    await insertMember("mbr_owner", "spc_1", "owner", "owner");
    await db.update(users).set({ deletionStartedAt: new Date() }).where(eq(users.id, "target"));

    await expect(
      insertSpaceMemberWithinCap(getAppDb(), {
        spaceId: "spc_1",
        userId: "target",
        memberId: "mbr_target",
        role: "member",
        now: new Date(),
        actorUserId: "owner",
      }),
    ).resolves.toBe("account-closing");
    await expect(db.query.spaceMembers.findFirst({ where: { userId: "target" } })).resolves.toBeUndefined();
  });

  it("does not add a member or touch the space when the cap is full", async () => {
    await insertUser("owner");
    await insertUser("target");
    await insertSpace("spc_1", "owner");
    await insertMember("mbr_owner", "spc_1", "owner", "owner");
    await fillSpace("spc_1", FREE_CAP);
    const before = await db.query.spaces.findFirst({ where: { id: "spc_1" } });
    const nextUpdatedAt = new Date((before?.updatedAt?.getTime() ?? Date.now()) + 1000);

    await expect(
      insertSpaceMemberWithinCap(getAppDb(), {
        spaceId: "spc_1",
        userId: "target",
        memberId: "mbr_target",
        role: "member",
        now: nextUpdatedAt,
        actorUserId: "owner",
      }),
    ).resolves.toBe("space-full");

    await expect(
      db.query.spaceMembers.findFirst({ where: { id: "mbr_target" } }),
    ).resolves.toBeUndefined();
    await expect(
      db.query.spaces.findFirst({ where: { id: "spc_1" } }),
    ).resolves.toMatchObject({ updatedAt: before?.updatedAt });
  });

  it("reports an existing member even when the Space is already at its cap", async () => {
    // The insert is a conditional SELECT: a full Space filters the row out
    // before the unique index can object, so the conflict this used to infer
    // "already-member" from never happened and the caller was told the Space
    // was full instead.
    await insertUser("owner");
    await insertUser("target");
    await insertSpace("spc_1", "owner");
    await insertMember("mbr_owner", "spc_1", "owner", "owner");
    await insertMember("mbr_target_existing", "spc_1", "target", "member");
    await fillSpace("spc_1", FREE_CAP);

    await expect(
      insertSpaceMemberWithinCap(getAppDb(), {
        spaceId: "spc_1",
        userId: "target",
        memberId: "mbr_target_new",
        role: "member",
        now: new Date(),
        actorUserId: "owner",
      }),
    ).resolves.toBe("already-member");
  });

  it("reports an existing member without changing their role", async () => {
    await insertUser("owner");
    await insertUser("target");
    await insertSpace("spc_1", "owner");
    await insertMember("mbr_owner", "spc_1", "owner", "owner");
    await insertMember("mbr_target_existing", "spc_1", "target", "member");

    await expect(
      insertSpaceMemberWithinCap(getAppDb(), {
        spaceId: "spc_1",
        userId: "target",
        memberId: "mbr_target_new",
        role: "admin",
        now: new Date(),
        actorUserId: "owner",
      }),
    ).resolves.toBe("already-member");

    await expect(
      db.query.spaceMembers.findFirst({ where: { id: "mbr_target_existing" } }),
    ).resolves.toMatchObject({ role: "member" });
    await expect(
      db.query.spaceMembers.findFirst({ where: { id: "mbr_target_new" } }),
    ).resolves.toBeUndefined();
  });

  it("does not write after the actor has been demoted", async () => {
    await insertUser("owner");
    await insertUser("admin");
    await insertUser("target");
    await insertSpace("spc_1", "owner");
    await insertMember("mbr_owner", "spc_1", "owner", "owner");
    await insertMember("mbr_admin", "spc_1", "admin", "member");

    await expect(
      insertSpaceMemberWithinCap(getAppDb(), {
        spaceId: "spc_1",
        userId: "target",
        memberId: "mbr_target",
        role: "member",
        now: new Date(),
        actorUserId: "admin",
      }),
    ).resolves.toBe("not-authorized");
    await expect(
      db.query.spaceMembers.findFirst({ where: { id: "mbr_target" } }),
    ).resolves.toBeUndefined();
  });

  it("does not grant admin after Organization ownership authority is lost", async () => {
    await insertUser("new_owner");
    await insertUser("former_owner");
    await insertUser("target");
    const now = new Date();
    await db.insert(organizations).values({
      id: "org_admin_fence",
      name: "Admin Fence",
      ownerId: "new_owner",
      plan: "organization",
      licenseLimit: 3,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(organizationMembers).values([
      { id: "omb_new_owner", organizationId: "org_admin_fence", userId: "new_owner", role: "admin", joinedAt: now },
      { id: "omb_former_owner", organizationId: "org_admin_fence", userId: "former_owner", role: "admin", joinedAt: now },
      { id: "omb_target", organizationId: "org_admin_fence", userId: "target", role: "member", joinedAt: now },
    ]);
    await db.insert(spaces).values({
      kind: "shared",
      id: "spc_admin_fence",
      slug: "admin-fence",
      name: "Admin Fence",
      ownerUserId: null,
      organizationId: "org_admin_fence",
      createdAt: now,
      updatedAt: now,
    });
    await insertMember("mbr_former_owner", "spc_admin_fence", "former_owner", "admin");

    await expect(insertSpaceMemberWithinCap(getAppDb(), {
      spaceId: "spc_admin_fence",
      userId: "target",
      memberId: "mbr_target_admin",
      role: "admin",
      now,
      actorUserId: "former_owner",
    })).resolves.toBe("not-authorized");
  });

  it("requires a license before adding someone to an Organization-funded Space", async () => {
    await insertUser("owner");
    await insertUser("target");
    const now = new Date();
    await db.insert(organizations).values({
      id: "org_1",
      name: "Acme",
      ownerId: "owner",
      plan: "organization",
      licenseLimit: 25,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(spaces).values({
      kind: "shared",
      id: "spc_org",
      slug: "spc-org",
      name: "Org Space",
      ownerUserId: null,
      organizationId: "org_1",
      createdAt: now,
      updatedAt: now,
    });
    await insertMember("mbr_owner", "spc_org", "owner", "admin");

    const add = () => insertSpaceMemberWithinCap(getAppDb(), {
      spaceId: "spc_org",
      userId: "target",
      memberId: "mbr_target",
      role: "member",
      now,
      actorUserId: "owner",
    });
    await expect(add()).resolves.toBe("license-required");

    await db.insert(organizationMembers).values({
      id: "organization_member_target",
      organizationId: "org_1",
      userId: "target",
      role: "member",
      joinedAt: now,
    });
    await expect(add()).resolves.toBe("inserted");
  });

  it("enforces the cap of whoever funds the Space as the write runs", async () => {
    // Authorized and capped against a Pro owner; ownership then moved to a
    // Free owner before the write. The write must see the Free cap.
    await insertUser("pro_owner", "pro");
    await insertUser("free_owner");
    await insertUser("target");
    await insertSpace("spc_1", "pro_owner");
    await insertMember("mbr_pro_owner", "spc_1", "pro_owner", "owner");
    await insertMember("mbr_free_owner", "spc_1", "free_owner", "admin");
    await fillSpace("spc_1", FREE_CAP);
    const add = (userId: string) => insertSpaceMemberWithinCap(getAppDb(), {
      spaceId: "spc_1",
      userId,
      memberId: `mbr_${userId}`,
      role: "member",
      now: new Date(),
      actorUserId: "free_owner",
    });

    await db.update(spaces).set({ ownerUserId: "free_owner" }).where(eq(spaces.id, "spc_1"));
    await expect(add("target")).resolves.toBe("space-full");
    expect(await db.$count(spaceMembers, eq(spaceMembers.spaceId, "spc_1"))).toBe(FREE_CAP);

    await db.update(spaces).set({ ownerUserId: "pro_owner" }).where(eq(spaces.id, "spc_1"));
    await expect(add("target")).resolves.toBe("inserted");
  });
});

