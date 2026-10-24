import { describe, it, expect, beforeEach } from "vitest";
import { PLAN_LIMITS } from "@/modules/billing/contract/plan-limits";
import { createTestDb, type TestDb } from "@/test/db";
import { spaces, users, spaceMembers, organizations } from "@orbmeet/db/schema";
import { eq, sql } from "drizzle-orm";
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

describe("Adversarial Stress Testing: Space Isolation & RBAC Invariants", () => {
  describe("1. Raw SQL & Malformed Mutation Attempts on Space Check Constraints", () => {
    it("rejects raw SQL UPDATE attempting to add organizationId to a personal space", async () => {
      await seedUser("usr_adv_p1");
      const spaceId = await seedPersonalSpace(db, "usr_adv_p1");

      const now = new Date();
      await db.insert(organizations).values({
        id: "org_adv_1",
        name: "Adversarial Org",
        ownerId: "usr_adv_p1",
        createdAt: now,
        updatedAt: now,
      });

      // Raw SQL UPDATE attempting to violate spaces_owner_shape_check
      await expect(
        db.run(
          sql`UPDATE spaces SET organization_id = 'org_adv_1' WHERE id = ${spaceId}`,
        ),
      ).rejects.toThrow();
    });

    it("rejects raw SQL UPDATE attempting to add ownerUserId to an organization space", async () => {
      await seedUser("usr_adv_org_owner");
      await seedUser("usr_adv_hijacker");
      const now = new Date();
      await db.insert(organizations).values({
        id: "org_adv_2",
        name: "Org 2",
        ownerId: "usr_adv_org_owner",
        createdAt: now,
        updatedAt: now,
      });

      const spaceId = await seedSharedSpace(db, {
        id: "space_adv_org_2",
        organizationId: "org_adv_2",
        slug: "adv-org-2",
        members: [{ userId: "usr_adv_org_owner", role: "owner" }],
      });

      // Attempting to set owner_user_id on an organization-owned space
      await expect(
        db.run(
          sql`UPDATE spaces SET owner_user_id = 'usr_adv_hijacker' WHERE id = ${spaceId}`,
        ),
      ).rejects.toThrow();
    });

    it("rejects raw SQL UPDATE attempting to add slug to a personal space", async () => {
      await seedUser("usr_adv_p2");
      const spaceId = await seedPersonalSpace(db, "usr_adv_p2");

      // Attempting to set slug on personal space
      await expect(
        db.run(
          sql`UPDATE spaces SET slug = 'injected-slug' WHERE id = ${spaceId}`,
        ),
      ).rejects.toThrow();
    });

    it("rejects raw SQL UPDATE attempting to nullify slug on a shared space", async () => {
      await seedUser("usr_adv_s1");
      const spaceId = await seedSharedSpace(db, {
        id: "space_adv_s1",
        ownerUserId: "usr_adv_s1",
        slug: "adv-s1",
        members: [{ userId: "usr_adv_s1", role: "owner" }],
      });

      // Attempting to nullify slug on shared space
      await expect(
        db.run(
          sql`UPDATE spaces SET slug = NULL WHERE id = ${spaceId}`,
        ),
      ).rejects.toThrow();
    });

    it("rejects raw SQL UPDATE attempting to archive a personal space", async () => {
      await seedUser("usr_adv_p3");
      const spaceId = await seedPersonalSpace(db, "usr_adv_p3");

      // Attempting to set archived_at on personal space
      await expect(
        db.run(
          sql`UPDATE spaces SET archived_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ${spaceId}`,
        ),
      ).rejects.toThrow();
    });

    it("rejects inserting a second personal space with raw SQL", async () => {
      await seedUser("usr_adv_p4");
      await seedPersonalSpace(db, "usr_adv_p4");

      // Direct raw SQL insert of second personal space
      await expect(
        db.run(
          sql`INSERT INTO spaces (id, kind, name, owner_user_id, created_at, updated_at)
              VALUES ('space_p4_second', 'personal', 'Second Space', 'usr_adv_p4', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
        ),
      ).rejects.toThrow();
    });
  });

  describe("2. Write-Time Authority Predicate (retainsSpaceManagerSql) Race Defenses", () => {
    it("rejects member insertion when admin was demoted immediately before SQL execution", async () => {
      await seedUser("usr_mgr_owner");
      await seedUser("usr_mgr_admin");
      await seedUser("usr_mgr_target");

      const spaceId = await seedSharedSpace(db, {
        id: "space_adv_rbac_1",
        ownerUserId: "usr_mgr_owner",
        slug: "adv-rbac-1",
        members: [
          { userId: "usr_mgr_owner", role: "owner" },
          { userId: "usr_mgr_admin", role: "admin" },
        ],
      });

      // Demote admin to member in database
      await db
        .update(spaceMembers)
        .set({ role: "member" })
        .where(
          sql`${spaceMembers.spaceId} = ${spaceId} AND ${spaceMembers.userId} = 'usr_mgr_admin'`,
        );

      const result = await insertSpaceMemberWithinCap(db, {
        spaceId,
        userId: "usr_mgr_target",
        memberId: "mem_adv_1",
        role: "member",
        now: new Date(),
        actorUserId: "usr_mgr_admin", // Demoted actor
      });

      expect(result).toBe("not-authorized");
      const insertedRow = await db
        .select()
        .from(spaceMembers)
        .where(eq(spaceMembers.id, "mem_adv_1"));
      expect(insertedRow).toHaveLength(0);
    });

    it("rejects member insertion when admin was deleted from space immediately before SQL execution", async () => {
      await seedUser("usr_del_owner");
      await seedUser("usr_del_admin");
      await seedUser("usr_del_target");

      const spaceId = await seedSharedSpace(db, {
        id: "space_adv_rbac_2",
        ownerUserId: "usr_del_owner",
        slug: "adv-rbac-2",
        members: [
          { userId: "usr_del_owner", role: "owner" },
          { userId: "usr_del_admin", role: "admin" },
        ],
      });

      // Delete admin from space_members
      await db
        .delete(spaceMembers)
        .where(
          sql`${spaceMembers.spaceId} = ${spaceId} AND ${spaceMembers.userId} = 'usr_del_admin'`,
        );

      const result = await insertSpaceMemberWithinCap(db, {
        spaceId,
        userId: "usr_del_target",
        memberId: "mem_adv_2",
        role: "member",
        now: new Date(),
        actorUserId: "usr_del_admin", // Evicted actor
      });

      expect(result).toBe("not-authorized");
      const insertedRow = await db
        .select()
        .from(spaceMembers)
        .where(eq(spaceMembers.id, "mem_adv_2"));
      expect(insertedRow).toHaveLength(0);
    });

    it("rejects member insertion when space was archived concurrently", async () => {
      await seedUser("usr_arch_owner");
      await seedUser("usr_arch_admin");
      await seedUser("usr_arch_target");

      const spaceId = await seedSharedSpace(db, {
        id: "space_adv_rbac_3",
        ownerUserId: "usr_arch_owner",
        slug: "adv-rbac-3",
        members: [
          { userId: "usr_arch_owner", role: "owner" },
          { userId: "usr_arch_admin", role: "admin" },
        ],
      });

      // Archive the space
      await db
        .update(spaces)
        .set({ archivedAt: new Date() })
        .where(eq(spaces.id, spaceId));

      const result = await insertSpaceMemberWithinCap(db, {
        spaceId,
        userId: "usr_arch_target",
        memberId: "mem_adv_3",
        role: "member",
        now: new Date(),
        actorUserId: "usr_arch_admin",
      });

      expect(result).toBe("not-authorized");
      const insertedRow = await db
        .select()
        .from(spaceMembers)
        .where(eq(spaceMembers.id, "mem_adv_3"));
      expect(insertedRow).toHaveLength(0);
    });
  });

  describe("3. High-Concurrency Space Member Cap Invariant", () => {
    it("strictly preserves space memberCap under 10 concurrent insertion attempts", async () => {
      await seedUser("usr_cap_owner");
      await seedUser("usr_cap_existing");

      const spaceId = await seedSharedSpace(db, {
        id: "space_adv_cap_1",
        ownerUserId: "usr_cap_owner",
        slug: "adv-cap-1",
        members: [
          { userId: "usr_cap_owner", role: "owner" },
          { userId: "usr_cap_existing", role: "member" },
        ],
      });

      // The owner's Free plan caps the Space; fill it to exactly one seat short.
      const memberCap = PLAN_LIMITS.free.maxMembersPerSpace!;
      for (let i = 2; i < memberCap - 1; i++) {
        await seedUser(`usr_cap_filler_${i}`);
        await db.insert(spaceMembers).values({
          id: `mem_cap_filler_${i}`,
          spaceId,
          userId: `usr_cap_filler_${i}`,
          role: "member",
          joinedAt: new Date(),
        });
      }

      // Seed 10 new candidate users
      for (let i = 1; i <= 10; i++) {
        await seedUser(`usr_candidate_${i}`);
      }

      // Launch 10 simultaneous insertion attempts by the space owner
      const insertionPromises = Array.from({ length: 10 }).map((_, i) => {
        const candidateId = `usr_candidate_${i + 1}`;
        return insertSpaceMemberWithinCap(db, {
          spaceId,
          userId: candidateId,
          memberId: `mem_candidate_${i + 1}`,
          role: "member",
          now: new Date(),
          actorUserId: "usr_cap_owner",
        });
      });

      const results = await Promise.all(insertionPromises);

      const insertedCount = results.filter((r) => r === "inserted").length;
      const spaceFullCount = results.filter((r) => r === "space-full").length;

      // Invariant: At most 1 can be inserted, remaining 9 receive "space-full"
      expect(insertedCount).toBe(1);
      expect(spaceFullCount).toBe(9);

      // Verify total members in DB does NOT exceed cap
      const allMembers = await db
        .select()
        .from(spaceMembers)
        .where(eq(spaceMembers.spaceId, spaceId));

      expect(allMembers).toHaveLength(memberCap); // Exactly at the cap, never past it.
    });
  });
});
