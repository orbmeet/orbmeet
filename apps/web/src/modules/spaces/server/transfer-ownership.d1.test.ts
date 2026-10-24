import { beforeEach, describe, expect, it } from "vitest";
import { organizations, meetingLinks, spaces, spaceMembers, users } from "@orbmeet/db/schema";
import { eq, sql } from "drizzle-orm";
import { createTestDb, type TestDb } from "@/test/db";
import {applyOwnershipTransfer} from "@/modules/spaces/server/membership.server";
import { evictUserFromSpaceMeetings } from "./evict-space-meetings.server";
import { findSpaceMembership } from "./helpers";

let db: TestDb;
const getAppDb = () => db;

// Default the recipient plan gates to "unlimited" so existing cases exercise the
// ownership-transfer mechanics; the dedicated cases below pass explicit limits.
function transfer(params: {
  spaceId: string;
  fromUserId: string;
  toUserId: string;
  now: Date;
  recipientMaxSpaces?: number | null;
  recipientMaxMembers?: number | null;
}) {
  return applyOwnershipTransfer(getAppDb(), {
    recipientMaxSpaces: null,
    recipientMaxMembers: null,
    ...params,
  });
}

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

async function insertMember(id: string, spaceId: string, userId: string, role: "owner" | "admin" | "member") {
  // An owner is named on the Space and stored as an admin member.
  await db.insert(spaceMembers).values({ id, spaceId, userId, role: role === "owner" ? "admin" : role, joinedAt: new Date() });
}

/** The role people see: "owner" comes from the Space, not the membership row. */
function roleIn(spaceId: string, userId: string) {
  return findSpaceMembership(db, spaceId, userId).then((membership) => membership?.role);
}

function ownerOf(spaceId: string) {
  return db.query.spaces.findFirst({ where: { id: spaceId } }).then((space) => space?.ownerUserId);
}

describe("applyOwnershipTransfer", () => {
  async function seed() {
    await insertUser("owner");
    await insertUser("target");
    await insertSpace("spc_1", "owner");
    await insertMember("mbr_owner", "spc_1", "owner", "owner");
    await insertMember("mbr_target", "spc_1", "target", "member");
    await db.insert(meetingLinks).values({
      id: "room_default",
      code: "abc-defg-hij",
      spaceId: "spc_1",
      spaceKind: "shared" as const,
      title: "Test Space",
      allowGuests: false,
      joinPolicy: "open",
      lastUsedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
      reusePolicy: "reusable",
    });
  }

  it("moves ownership on the Space and raises the recipient to admin", async () => {
    await seed();

    const ok = await transfer({
      spaceId: "spc_1",
      fromUserId: "owner",
      toUserId: "target",
      now: new Date(),
    });

    expect(ok).toBe(true);
    await expect(ownerOf("spc_1")).resolves.toBe("target");
    // Both stored memberships are admin; only the Space says who owns it.
    await expect(
      db.query.spaceMembers.findFirst({ where: { userId: "target" } }),
    ).resolves.toMatchObject({ role: "admin" });
    await expect(
      db.query.spaceMembers.findFirst({ where: { userId: "owner" } }),
    ).resolves.toMatchObject({ role: "admin" });
    await expect(roleIn("spc_1", "target")).resolves.toBe("owner");
    await expect(roleIn("spc_1", "owner")).resolves.toBe("admin");
    // The default link stays owned by the space itself through the transfer.
    await expect(
      db.query.meetingLinks.findFirst({ where: { id: "room_default" } }),
    ).resolves.toMatchObject({ reusePolicy: "reusable", spaceId: "spc_1" });
  });

  it("prevents a stale removal from deleting the newly promoted owner", async () => {
    await seed();
    await transfer({ spaceId: "spc_1", fromUserId: "owner", toUserId: "target", now: new Date() });

    await expect(
      evictUserFromSpaceMeetings(getAppDb(), {} as Env, "spc_1", "target"),
    ).resolves.toBe(false);
    await expect(roleIn("spc_1", "target")).resolves.toBe("owner");
  });

  it("reports a conflict (no corruption) when the caller is no longer the owner", async () => {
    await seed();
    // Simulate a transfer that already happened: target is now owner, ex-owner is admin.
    await transfer({ spaceId: "spc_1", fromUserId: "owner", toUserId: "target", now: new Date() });

    await insertUser("third");
    await insertMember("mbr_third", "spc_1", "third", "member");

    // The stale "owner" tries to transfer again — they're no longer the owner.
    const ok = await transfer({
      spaceId: "spc_1",
      fromUserId: "owner",
      toUserId: "third",
      now: new Date(),
    });

    expect(ok).toBe(false);
    // State must be untouched by the failed transfer.
    await expect(ownerOf("spc_1")).resolves.toBe("target");
    await expect(roleIn("spc_1", "target")).resolves.toBe("owner");
    await expect(roleIn("spc_1", "third")).resolves.toBe("member");
  });

  it("does not corrupt state when the target is no longer a member", async () => {
    await insertUser("owner");
    await insertUser("target");
    await insertSpace("spc_1", "owner");
    await insertMember("mbr_owner", "spc_1", "owner", "owner");

    const ok = await transfer({
      spaceId: "spc_1",
      fromUserId: "owner",
      toUserId: "target",
      now: new Date(),
    });

    expect(ok).toBe(false);
    await expect(roleIn("spc_1", "owner")).resolves.toBe("owner");
    await expect(
      db.query.spaceMembers.findFirst({ where: { userId: "target" } }),
    ).resolves.toBeUndefined();
    await expect(
      db.query.spaces.findFirst({ where: { id: "spc_1" } }),
    ).resolves.toMatchObject({ ownerUserId: "owner" });
  });

  it("blocks the transfer when the recipient is already at their owned-space cap", async () => {
    await seed();
    // Recipient already owns another space; their plan allows only 1.
    await insertSpace("spc_other", "target");
    await insertMember("mbr_other_owner", "spc_other", "target", "owner");

    const ok = await transfer({
      spaceId: "spc_1",
      fromUserId: "owner",
      toUserId: "target",
      now: new Date(),
      recipientMaxSpaces: 1,
      recipientMaxMembers: null,
    });

    expect(ok).toBe(false);
    // Original ownership is untouched.
    await expect(ownerOf("spc_1")).resolves.toBe("owner");
    await expect(roleIn("spc_1", "owner")).resolves.toBe("owner");
  });

  it("blocks the transfer when the space exceeds the recipient's per-space member cap", async () => {
    await seed(); // owner + target = 2 members

    const ok = await transfer({
      spaceId: "spc_1",
      fromUserId: "owner",
      toUserId: "target",
      now: new Date(),
      recipientMaxSpaces: null,
      recipientMaxMembers: 1,
    });

    expect(ok).toBe(false);
    await expect(
      db.query.spaces.findFirst({ where: { id: "spc_1" } }),
    ).resolves.toMatchObject({ ownerUserId: "owner" });
    await expect(roleIn("spc_1", "target")).resolves.toBe("member");
  });

  it("allows the transfer when the recipient's limits are exactly met", async () => {
    await seed(); // 2 members, target owns no other space

    const ok = await transfer({
      spaceId: "spc_1",
      fromUserId: "owner",
      toUserId: "target",
      now: new Date(),
      recipientMaxSpaces: 1, // owns 0, room for this one
      recipientMaxMembers: 2, // space has exactly 2
    });

    expect(ok).toBe(true);
    await expect(
      db.query.spaces.findFirst({ where: { id: "spc_1" } }),
    ).resolves.toMatchObject({ ownerUserId: "target" });
  });

  it("does not charge the recipient's archived Spaces against their active quota", async () => {
    await seed();
    await insertSpace("spc_archived", "target");
    await db.update(spaces)
      .set({ archivedAt: new Date() })
      .where(eq(spaces.id, "spc_archived"));

    await expect(transfer({
      spaceId: "spc_1",
      fromUserId: "owner",
      toUserId: "target",
      now: new Date(),
      recipientMaxSpaces: 1,
      recipientMaxMembers: null,
    })).resolves.toBe(true);
  });

  it("excludes the recipient's org-owned spaces from their personal owned-space cap", async () => {
    await seed();
    // Recipient owns an *org* space. Org spaces don't consume the personal owned-space
    // quota (matching createSpace's `organization_id is null` gate), so a recipient with
    // maxSpaces=1 and zero personal spaces can still receive this personal space.
    await db.insert(organizations).values({
      id: "org_1",
      name: "Acme",
      ownerId: "target",
      plan: "organization",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await insertSpace("spc_org", "target");
    await db.update(spaces).set({ ownerUserId: null, organizationId: "org_1" }).where(eq(spaces.id, "spc_org"));
    await insertMember("mbr_org_owner", "spc_org", "target", "owner");

    const ok = await transfer({
      spaceId: "spc_1",
      fromUserId: "owner",
      toUserId: "target",
      now: new Date(),
      recipientMaxSpaces: 1,
      recipientMaxMembers: null,
    });

    expect(ok).toBe(true);
    await expect(
      db.query.spaces.findFirst({ where: { id: "spc_1" } }),
    ).resolves.toMatchObject({ ownerUserId: "target" });
  });

  it("DB rejects an owner role on a membership row: ownership lives on the Space", async () => {
    await seed();
    await insertUser("rogue");
    await expect(
      db.run(sql`insert into ${spaceMembers} (id, space_id, user_id, role, joined_at)
        values ('mbr_rogue', 'spc_1', 'rogue', 'owner', 0)`),
    ).rejects.toThrow();
  });
});
