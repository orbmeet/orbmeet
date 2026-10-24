import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type TestDb } from "@/test/db";
import { spaces, users, organizations } from "@orbmeet/db/schema";
import { eq } from "drizzle-orm";
import { seedPersonalSpace, seedSharedSpace } from "@/test/fixtures";
import {insertSpaceMemberWithinCap} from "@/modules/spaces/server/membership.server";

let db: TestDb;

beforeEach(async () => {
  db = await createTestDb();
});

async function seedUser(id: string, name = id) {
  const now = new Date();
  await db.insert(users).values({
    id,
    name,
    email: `${id}@example.com`,
    normalizedEmail: `${id}@example.com`,
    plan: "free",
    role: "user",
    createdAt: now,
    updatedAt: now,
  });
}

describe("Empirical Space Isolation & RBAC Verification", () => {
  describe("a. Database Check Constraints on Space Shapes", () => {
    it("enforces spaces_owner_shape_check: rejects space with both ownerUserId and organizationId", async () => {
      await seedUser("usr_owner_1");
      const now = new Date();
      await db.insert(organizations).values({
        id: "org_1",
        name: "Test Org",
        ownerId: "usr_owner_1",
        createdAt: now,
        updatedAt: now,
      });

      // Attempting to insert a space with BOTH ownerUserId AND organizationId must violate CHECK constraint
      await expect(
        db.insert(spaces).values({
          id: "space_invalid_both",
          kind: "shared",
          name: "Invalid Space",
          slug: "invalid-both",
          ownerUserId: "usr_owner_1",
          organizationId: "org_1",
          createdAt: now,
          updatedAt: now,
        }),
      ).rejects.toThrow();
    });

    it("enforces spaces_owner_shape_check: rejects space with neither ownerUserId nor organizationId", async () => {
      const now = new Date();
      // Attempting to insert a space with NEITHER ownerUserId NOR organizationId must violate CHECK constraint
      await expect(
        db.insert(spaces).values({
          id: "space_invalid_none",
          kind: "shared",
          name: "Invalid Space",
          slug: "invalid-none",
          ownerUserId: null,
          organizationId: null,
          createdAt: now,
          updatedAt: now,
        }),
      ).rejects.toThrow();
    });

    it("enforces spaces_slug_shape_check: rejects personal space with a slug", async () => {
      await seedUser("usr_personal_slug");
      const now = new Date();
      // Personal space must have NULL slug
      await expect(
        db.insert(spaces).values({
          id: "space_personal_with_slug",
          kind: "personal",
          name: "Personal Space",
          slug: "illegal-personal-slug",
          ownerUserId: "usr_personal_slug",
          organizationId: null,
          createdAt: now,
          updatedAt: now,
        }),
      ).rejects.toThrow();
    });

    it("enforces spaces_slug_shape_check: rejects shared space with null slug", async () => {
      await seedUser("usr_shared_no_slug");
      const now = new Date();
      // Shared space must have non-null slug
      await expect(
        db.insert(spaces).values({
          id: "space_shared_no_slug",
          kind: "shared",
          name: "Shared Space",
          slug: null,
          ownerUserId: "usr_shared_no_slug",
          organizationId: null,
          createdAt: now,
          updatedAt: now,
        }),
      ).rejects.toThrow();
    });

    it("enforces spaces_personal_shape_check: rejects archiving a personal space", async () => {
      await seedUser("usr_personal_archive");
      const now = new Date();
      // Personal space cannot have archivedAt set (lives and dies with user account)
      await expect(
        db.insert(spaces).values({
          id: "space_personal_archived",
          kind: "personal",
          name: "Personal Space",
          slug: null,
          ownerUserId: "usr_personal_archive",
          organizationId: null,
          archivedAt: now,
          createdAt: now,
          updatedAt: now,
        }),
      ).rejects.toThrow();
    });

    it("enforces spaces_personal_owner_unique_idx: rejects multiple personal spaces for one user", async () => {
      await seedUser("usr_single_personal");
      await seedPersonalSpace(db, "usr_single_personal");

      const now = new Date();
      // Attempting to insert a second personal space for the same owner must violate unique index
      await expect(
        db.insert(spaces).values({
          id: "space_personal_second",
          kind: "personal",
          name: "Second Personal Space",
          slug: null,
          ownerUserId: "usr_single_personal",
          organizationId: null,
          createdAt: now,
          updatedAt: now,
        }),
      ).rejects.toThrow();
    });
  });

  describe("b. retainsSpaceManagerSql Write-Time Authority Fence", () => {
    it("permits member insertion when actor is a valid space admin", async () => {
      await seedUser("usr_owner");
      await seedUser("usr_admin");
      await seedUser("usr_target");

      const spaceId = await seedSharedSpace(db, {
        id: "space_rbac_1",
        ownerUserId: "usr_owner",
        slug: "rbac-1",
        members: [
          { userId: "usr_owner", role: "owner" },
          { userId: "usr_admin", role: "admin" },
        ],
      });

      const result = await insertSpaceMemberWithinCap(db, {
        spaceId,
        userId: "usr_target",
        memberId: "mem_target_1",
        role: "member",
        now: new Date(),
        actorUserId: "usr_admin",
      });

      expect(result).toBe("inserted");
      const memberRow = await db.query.spaceMembers.findFirst({
        where: { id: "mem_target_1" },
      });
      expect(memberRow?.userId).toBe("usr_target");
    });

    it("fails closed (returns not-authorized) when admin was demoted before write executes", async () => {
      await seedUser("usr_owner");
      await seedUser("usr_demoted_admin");
      await seedUser("usr_target_2");

      const spaceId = await seedSharedSpace(db, {
        id: "space_rbac_2",
        ownerUserId: "usr_owner",
        slug: "rbac-2",
        members: [
          { userId: "usr_owner", role: "owner" },
          { userId: "usr_demoted_admin", role: "member" }, // Demoted to plain member!
        ],
      });

      // The demoted user attempts to insert a member
      const result = await insertSpaceMemberWithinCap(db, {
        spaceId,
        userId: "usr_target_2",
        memberId: "mem_target_2",
        role: "member",
        now: new Date(),
        actorUserId: "usr_demoted_admin",
      });

      // Write-time authority predicate blocks the insertion
      expect(result).toBe("not-authorized");
      const memberRow = await db.query.spaceMembers.findFirst({
        where: { id: "mem_target_2" },
      });
      expect(memberRow).toBeUndefined();
    });

    it("fails closed when space has been archived concurrently", async () => {
      await seedUser("usr_owner_arch");
      await seedUser("usr_admin_arch");
      await seedUser("usr_target_3");

      const spaceId = await seedSharedSpace(db, {
        id: "space_rbac_3",
        ownerUserId: "usr_owner_arch",
        slug: "rbac-3",
        members: [
          { userId: "usr_owner_arch", role: "owner" },
          { userId: "usr_admin_arch", role: "admin" },
        ],
      });

      // Archive the space
      await db
        .update(spaces)
        .set({ archivedAt: new Date() })
        .where(eq(spaces.id, spaceId));

      const result = await insertSpaceMemberWithinCap(db, {
        spaceId,
        userId: "usr_target_3",
        memberId: "mem_target_3",
        role: "member",
        now: new Date(),
        actorUserId: "usr_admin_arch",
      });

      expect(result).toBe("not-authorized");
    });
  });
});
