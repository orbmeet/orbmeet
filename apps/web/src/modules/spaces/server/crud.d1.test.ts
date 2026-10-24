import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  meetingLinks,
  meetings,
  organizationMembers,
  organizations,
  spaces,
  spaceMembers,
  users,
} from "@orbmeet/db/schema";
import { createTestDb, type TestDb } from "@/test/db";
import {findViewableSpaceIdBySlug, insertSpaceWithInitialMembership, updateSpaceProfile} from "@/modules/spaces/server/crud.server";

let db: TestDb;
const getAppDb = () => db;

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
    plan: "free",
    role: "user",
    createdAt: now,
    updatedAt: now,
  });
}

describe("insertSpaceWithInitialMembership", () => {
  it("creates the space and owner membership when under the plan limit", async () => {
    await insertUser("owner");
    const now = new Date();

    await expect(
      insertSpaceWithInitialMembership(getAppDb(), {
        spaceId: "SPACE_1",
        slug: "space-one",
        memberId: "MEMBER_1",
        meetingLinkId: "LINK_1",
        meetingLinkCode: "abc-defg-hij",
        inviteId: "INVITE_1",
        inviteToken: "aaaaaaaa",
        creatorUserId: "owner",
        name: "Space One",
        description: null,
        now,
        maxSpaces: 1,
      }),
    ).resolves.toBe(true);

    await expect(db.query.spaces.findFirst({ where: { id: "SPACE_1" } })).resolves.toMatchObject({
      id: "SPACE_1",
      ownerUserId: "owner",
    });
    await expect(
      db.query.spaceMembers.findFirst({ where: { id: "MEMBER_1" } }),
    ).resolves.toMatchObject({
      id: "MEMBER_1",
      spaceId: "SPACE_1",
      userId: "owner",
      // The Space names its owner; the owner's membership is an admin one.
      role: "admin",
    });
    await expect(
      db.query.meetingLinks.findFirst({ where: { id: "LINK_1" } }),
    ).resolves.toMatchObject({
      reusePolicy: "reusable",
      spaceId: "SPACE_1",
      title: null,
      lastUsedAt: null,
    });
    await expect(
      db.query.spaceInvites.findFirst({ where: { id: "INVITE_1" } }),
    ).resolves.toMatchObject({ spaceId: "SPACE_1", token: "aaaaaaaa" });
  });

  it("does not create ownership after account deletion closes the gate", async () => {
    await insertUser("deleting_owner");
    const now = new Date();
    await db.update(users).set({ deletionStartedAt: now })
      .where(eq(users.id, "deleting_owner"));

    await expect(insertSpaceWithInitialMembership(getAppDb(), {
      spaceId: "SPACE_DELETING",
      slug: "space-deleting",
      memberId: "MEMBER_DELETING",
      meetingLinkId: "LINK_DELETING",
      meetingLinkCode: "del-eting-one",
      inviteId: "INVITE_DELETING",
      inviteToken: "dddddddd",
      creatorUserId: "deleting_owner",
      name: "Must not exist",
      description: null,
      now,
      maxSpaces: 1,
    })).resolves.toBe(false);
    await expect(db.query.spaces.findFirst({ where: { id: "SPACE_DELETING" } }))
      .resolves.toBeUndefined();
  });

  it("refuses creation without leaving partial rows behind when the limit is reached", async () => {
    await insertUser("owner");
    const now = new Date();

    await db.insert(spaces).values({
      kind: "shared",
      id: "SPACE_EXISTING",
      slug: "SPACE_EXISTING-slug",
      name: "Existing",
      description: null,
      ownerUserId: "owner",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(spaceMembers).values({
      id: "MEMBER_EXISTING",
      spaceId: "SPACE_EXISTING",
      userId: "owner",
      role: "admin",
      joinedAt: now,
    });

    await expect(
      insertSpaceWithInitialMembership(getAppDb(), {
        spaceId: "SPACE_BLOCKED",
        slug: "blocked",
        memberId: "MEMBER_BLOCKED",
        meetingLinkId: "LINK_BLOCKED",
        meetingLinkCode: "bcd-efgh-ijk",
        inviteId: "INVITE_BLOCKED",
        inviteToken: "bbbbbbbb",
        creatorUserId: "owner",
        name: "Blocked",
        description: null,
        now,
        maxSpaces: 1,
      }),
    ).resolves.toBe(false);

    await expect(db.query.spaces.findFirst({ where: { id: "SPACE_BLOCKED" } })).resolves.toBeUndefined();
    await expect(
      db.query.spaceMembers.findFirst({ where: { id: "MEMBER_BLOCKED" } }),
    ).resolves.toBeUndefined();
    await expect(
      db.query.meetingLinks.findFirst({ where: { id: "LINK_BLOCKED" } }),
    ).resolves.toBeUndefined();
    await expect(
      db.query.spaceInvites.findFirst({ where: { id: "INVITE_BLOCKED" } }),
    ).resolves.toBeUndefined();
  });

  it("does not charge an archived Space against the active Space quota", async () => {
    await insertUser("owner");
    const now = new Date();
    await db.insert(spaces).values({
      kind: "shared",
      id: "SPACE_ARCHIVED",
      slug: "archived",
      name: "Archived",
      ownerUserId: "owner",
      archivedAt: now,
      createdAt: now,
      updatedAt: now,
    });

    await expect(insertSpaceWithInitialMembership(getAppDb(), {
      spaceId: "SPACE_REPLACEMENT",
      slug: "replacement",
      memberId: "MEMBER_REPLACEMENT",
      meetingLinkId: "LINK_REPLACEMENT",
      meetingLinkCode: "rep-lace-men",
      inviteId: "INVITE_REPLACEMENT",
      inviteToken: "cccccccc",
      creatorUserId: "owner",
      name: "Replacement",
      description: null,
      now,
      maxSpaces: 1,
    })).resolves.toBe(true);
  });

  it("re-checks Organization admin authority inside the creation batch", async () => {
    await insertUser("org_owner");
    await insertUser("former_admin");
    const now = new Date();
    await db.insert(organizations).values({
      id: "org_1",
      name: "Acme",
      ownerId: "org_owner",
      plan: "organization",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(organizationMembers).values({
      id: "org_member_1",
      organizationId: "org_1",
      userId: "former_admin",
      role: "admin",
      joinedAt: now,
    });
    // Simulate removal after the handler's explanatory pre-check.
    await db.delete(organizationMembers).where(eq(organizationMembers.id, "org_member_1"));

    await expect(insertSpaceWithInitialMembership(getAppDb(), {
      spaceId: "SPACE_FORBIDDEN",
      slug: "forbidden",
      memberId: "MEMBER_FORBIDDEN",
      meetingLinkId: "LINK_FORBIDDEN",
      meetingLinkCode: "for-bidd-den",
      inviteId: "INVITE_FORBIDDEN",
      inviteToken: "dddddddd",
      creatorUserId: "former_admin",
      name: "Forbidden",
      description: null,
      now,
      maxSpaces: null,
      organizationId: "org_1",
    })).resolves.toBe(false);
    await expect(db.query.spaces.findFirst({ where: { id: "SPACE_FORBIDDEN" } }))
      .resolves.toBeUndefined();
    await expect(db.query.spaceMembers.findFirst({ where: { id: "MEMBER_FORBIDDEN" } }))
      .resolves.toBeUndefined();
  });

  it("allows the current Organization owner to create without a projected membership", async () => {
    await insertUser("org_owner");
    const now = new Date();
    await db.insert(organizations).values({
      id: "org_1",
      name: "Acme",
      ownerId: "org_owner",
      plan: "organization",
      createdAt: now,
      updatedAt: now,
    });

    await expect(insertSpaceWithInitialMembership(getAppDb(), {
      spaceId: "SPACE_ORG",
      slug: "org-space",
      memberId: "MEMBER_ORG",
      meetingLinkId: "LINK_ORG",
      meetingLinkCode: "org-spac-lin",
      inviteId: "INVITE_ORG",
      inviteToken: "eeeeeeee",
      creatorUserId: "org_owner",
      name: "Org Space",
      description: null,
      now,
      maxSpaces: null,
      organizationId: "org_1",
    })).resolves.toBe(true);
  });
});

describe("updateSpaceProfile", () => {
  it("renames only the Space without rewriting its Link or Meeting history", async () => {
    await insertUser("owner");
    const now = new Date();
    await db.insert(spaces).values({
      kind: "shared",
      id: "SPACE_1",
      slug: "SPACE_1-slug",
      name: "Old name",
      ownerUserId: "owner",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(spaceMembers).values({
      id: "MEMBER_OWNER",
      spaceId: "SPACE_1",
      userId: "owner",
      role: "admin",
      joinedAt: now,
    });
    await db.insert(meetingLinks).values({
      id: "LINK_1",
      code: "abc-defg-hij",
      spaceId: "SPACE_1",
spaceKind: "shared" as const,
      reusePolicy: "reusable",
      title: "Old name",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(meetings).values({
      id: "MEETING_1",
      meetingLinkId: "LINK_1",
      title: "Old name",
      spaceId: "SPACE_1",
    spaceKind: "shared" as const,
      status: "ended",
    billingPrincipalType: "user" as const,
    billingPrincipalId: "host",
    billingPlan: "free",
      startedAt: now,
      endedAt: now,
      updatedAt: now,
    });

    await updateSpaceProfile(getAppDb(), "SPACE_1", "owner", {
      name: "New name",
      expected: { name: "Old name", description: null, timeZone: "UTC" },
    });

    await expect(db.query.spaces.findFirst({ where: { id: "SPACE_1" } }))
      .resolves.toMatchObject({ name: "New name" });
    await expect(db.query.meetingLinks.findFirst({ where: { id: "LINK_1" } }))
      .resolves.toMatchObject({ title: "Old name" });
    await expect(db.query.meetings.findFirst({ where: { id: "MEETING_1" } }))
      .resolves.toMatchObject({ title: "Old name" });
  });

  it("does not update after the actor has been demoted", async () => {
    await insertUser("owner");
    await insertUser("admin");
    const now = new Date();
    await db.insert(spaces).values({
      kind: "shared",
      id: "SPACE_1",
      slug: "SPACE_1-slug",
      name: "Original",
      ownerUserId: "owner",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(spaceMembers).values([
      {
        id: "MEMBER_OWNER",
        spaceId: "SPACE_1",
        userId: "owner",
        role: "admin",
        joinedAt: now,
      },
      {
        id: "MEMBER_ADMIN",
        spaceId: "SPACE_1",
        userId: "admin",
        role: "member",
        joinedAt: now,
      },
    ]);

    await expect(updateSpaceProfile(
      getAppDb(),
      "SPACE_1",
      "admin",
      {
        name: "Unauthorized",
        expected: { name: "Original", description: null, timeZone: "UTC" },
      },
    )).resolves.toBe(false);
    await expect(db.query.spaces.findFirst({ where: { id: "SPACE_1" } }))
      .resolves.toMatchObject({ name: "Original" });
  });

  it("rejects a stale write to the same field without blocking independent fields", async () => {
    await insertUser("owner");
    const now = new Date();
    await db.insert(spaces).values({
      kind: "shared",
      id: "SPACE_1",
      slug: "SPACE_1-slug",
      name: "Original",
      description: "First",
      ownerUserId: "owner",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(spaceMembers).values({
      id: "MEMBER_OWNER",
      spaceId: "SPACE_1",
      userId: "owner",
      role: "admin",
      joinedAt: now,
    });

    const baseline = { name: "Original", description: "First", timeZone: "UTC" };
    await expect(updateSpaceProfile(getAppDb(), "SPACE_1", "owner", {
      description: "Second",
      expected: baseline,
    })).resolves.toBe(true);
    await expect(updateSpaceProfile(getAppDb(), "SPACE_1", "owner", {
      name: "Renamed",
      expected: baseline,
    })).resolves.toBe(true);
    await expect(updateSpaceProfile(getAppDb(), "SPACE_1", "owner", {
      description: "Stale overwrite",
      expected: baseline,
    })).resolves.toBe(false);

    await expect(db.query.spaces.findFirst({ where: { id: "SPACE_1" } }))
      .resolves.toMatchObject({ name: "Renamed", description: "Second" });
  });
});

describe("findViewableSpaceIdBySlug", () => {
  it("makes missing and inaccessible slugs indistinguishable", async () => {
    await insertUser("owner");
    await insertUser("member");
    await insertUser("stranger");
    const now = new Date();
    await db.insert(spaces).values({
      kind: "shared",
      id: "SPACE_PRIVATE",
      slug: "private-team",
      name: "Private Team",
      ownerUserId: "owner",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(spaceMembers).values([
      { id: "MEMBER_OWNER", spaceId: "SPACE_PRIVATE", userId: "owner", role: "admin", joinedAt: now },
      { id: "MEMBER_MEMBER", spaceId: "SPACE_PRIVATE", userId: "member", role: "member", joinedAt: now },
    ]);

    await expect(findViewableSpaceIdBySlug(db, "private-team", "member"))
      .resolves.toBe("SPACE_PRIVATE");
    await expect(findViewableSpaceIdBySlug(db, "private-team", "stranger"))
      .resolves.toBeNull();
    await expect(findViewableSpaceIdBySlug(db, "missing-team", "stranger"))
      .resolves.toBeNull();
  });
});
