import { beforeEach, describe, expect, it } from "vitest";
import { organizationMembers, organizations, spaces, spaceInvites, spaceMembers, users } from "@orbmeet/db/schema";
import { PLAN_LIMITS } from "@/modules/billing/contract/plan-limits";
import { createTestDb, type TestDb } from "@/test/db";
import {applyInviteMembership, replaceSpaceInviteRecord} from "@/modules/spaces/server/invites.server";
import { evictUserFromSpaceMeetings } from "@/modules/spaces/server/evict-space-meetings.server";
import { insertSpaceMemberWithinCap } from "@/modules/spaces/server/membership.server";
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
    role: "user",
    createdAt: now,
    updatedAt: now,
  });
}

async function insertSpace(archivedAt: Date | null = null) {
  const now = new Date();
  await db.insert(spaces).values({
    kind: "shared",
    id: "spc_1",
    slug: "spc_1-slug",
    name: "Classroom",
    ownerUserId: "owner",
    archivedAt,
    createdAt: now,
    updatedAt: now,
  });
}

async function insertInvite() {
  await db.insert(spaceInvites).values({
    id: "inv_1",
    spaceId: "spc_1",
    token: "aaaaaaaa",
    createdByUserId: "owner",
    createdAt: new Date(),
  });
}

async function join() {
  return applyInviteMembership(appDb(), {
    invite: { id: "inv_1", spaceId: "spc_1" },
    userId: "joiner",
    memberId: "mbr_joiner",
    now: new Date(),
  });
}

describe("applyInviteMembership", () => {
  it("adds a member without consuming the permanent invitation", async () => {
    await insertUser("owner");
    await insertUser("joiner");
    await insertSpace();
    await insertInvite();

    await expect(join()).resolves.toBe(true);
    await expect(
      db.query.spaceMembers.findFirst({ where: { id: "mbr_joiner" } }),
    ).resolves.toMatchObject({ role: "member", userId: "joiner" });
    await expect(
      db.query.spaceInvites.findFirst({ where: { id: "inv_1" } }),
    ).resolves.toBeDefined();
  });

  it("refuses a URL that was rotated after it was read", async () => {
    await insertUser("owner");
    await insertUser("joiner");
    await insertSpace();

    await expect(join()).resolves.toBe(false);
  });

  it("refuses to join an archived Space", async () => {
    await insertUser("owner");
    await insertUser("joiner");
    await insertSpace(new Date(Date.now() + 1_000));
    await insertInvite();

    await expect(join()).resolves.toBe(false);
  });

  it("atomically enforces the member cap", async () => {
    await insertUser("owner");
    await insertUser("joiner");
    await insertSpace();
    await insertInvite();
    await db.insert(spaceMembers).values({
      id: "mbr_owner",
      spaceId: "spc_1",
      userId: "owner",
      role: "admin",
      joinedAt: new Date(),
    });
    for (let index = 1; index < PLAN_LIMITS.free.maxMembersPerSpace!; index++) {
      await insertUser(`filler_${index}`);
      await db.insert(spaceMembers).values({
        id: `mbr_filler_${index}`,
        spaceId: "spc_1",
        userId: `filler_${index}`,
        role: "member",
        joinedAt: new Date(),
      });
    }

    // Full on the owner's Free plan; the cap is read from the plan as the
    // write runs, so an upgrade between attempts makes room at once.
    await expect(join()).resolves.toBe(false);
    await seedSubscription(db, { userId: "owner" });
    await expect(join()).resolves.toBe(true);
  });

  it("atomically requires an Organization license", async () => {
    await insertUser("owner");
    await insertUser("joiner");
    const now = new Date();
    await db.insert(organizations).values({
      id: "org_1",
      name: "Acme",
      ownerId: "owner",
      createdAt: now,
      updatedAt: now,
    });
    await seedSubscription(db, { organizationId: "org_1", seats: 25 });
    await db.insert(spaces).values({
      kind: "shared",
      id: "spc_1",
      slug: "spc_1-slug",
      name: "Classroom",
      ownerUserId: null,
      organizationId: "org_1",
      createdAt: now,
      updatedAt: now,
    });
    await insertInvite();

    await expect(join()).resolves.toBe(false);
    await db.insert(organizationMembers).values({
      id: "organization_member_joiner",
      organizationId: "org_1",
      userId: "joiner",
      role: "member",
      joinedAt: now,
    });
    await expect(join()).resolves.toBe(true);
  });

  it("replaces the invitation atomically and invalidates its old database identity", async () => {
    await insertUser("owner");
    await insertSpace();
    await insertInvite();
    await db.insert(spaceMembers).values({
      id: "mbr_owner",
      spaceId: "spc_1",
      userId: "owner",
      role: "admin",
      joinedAt: new Date(),
    });

    const replacement = await replaceSpaceInviteRecord(appDb(), {
      spaceId: "spc_1",
      currentInviteId: "inv_1",
      actorUserId: "owner",
    });
    expect(replacement).not.toBeNull();
    await expect(
      db.query.spaceInvites.findFirst({ where: { id: "inv_1" } }),
    ).resolves.toBeUndefined();
    await expect(
      db.query.spaceInvites.findFirst({ where: { id: replacement!.inviteId } }),
    ).resolves.toMatchObject({ token: replacement!.token });
    // The replacement code is a freshly generated 8-letter invite code.
    expect(replacement!.token).toMatch(/^[a-zA-Z]{8}$/);
  });
});

describe("a member a Space admin removed", () => {
  async function seedSpaceWithMember() {
    await insertUser("owner");
    await insertUser("joiner");
    await insertSpace();
    await insertInvite();
    const now = new Date();
    await db.insert(spaceMembers).values([
      { id: "mbr_owner", spaceId: "spc_1", userId: "owner", role: "admin", joinedAt: now },
      { id: "mbr_first", spaceId: "spc_1", userId: "joiner", role: "member", joinedAt: now },
    ]);
  }
  const env = {} as Env;
  const removal = () => db.query.spaceMemberRemovals.findFirst({ where: { spaceId: "spc_1", userId: "joiner" } });

  it("cannot rejoin with the invite link until an admin adds them back", async () => {
    await seedSpaceWithMember();
    await expect(evictUserFromSpaceMeetings(appDb(), env, "spc_1", "joiner", {
      authorizedByUserId: "owner",
      removedBy: { userId: "owner", at: new Date() },
    })).resolves.toBe(true);
    await expect(removal()).resolves.toMatchObject({ removedByUserId: "owner" });

    await expect(join()).resolves.toBe(false);
    await expect(db.query.spaceMembers.findFirst({ where: { spaceId: "spc_1", userId: "joiner" } })).resolves.toBeUndefined();

    await expect(insertSpaceMemberWithinCap(appDb(), {
      spaceId: "spc_1", userId: "joiner", memberId: "mbr_again", role: "member", now: new Date(), actorUserId: "owner",
    })).resolves.toBe("inserted");
    await expect(removal()).resolves.toBeUndefined();
  });

  it("can rejoin with the invite link after leaving by choice", async () => {
    await seedSpaceWithMember();
    await expect(evictUserFromSpaceMeetings(appDb(), env, "spc_1", "joiner")).resolves.toBe(true);
    await expect(removal()).resolves.toBeUndefined();
    await expect(join()).resolves.toBe(true);
  });
});
