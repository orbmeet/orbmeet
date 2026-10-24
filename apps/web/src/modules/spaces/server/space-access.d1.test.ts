import { beforeEach, describe, expect, it } from "vitest";
import {
  organizationMembers,
  organizations,
  spaces,
  spaceMembers,
  users,
} from "@orbmeet/db/schema";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "@/test/db";
import { assertSpaceCapability, getSpaceAccess, selectSpacesForUser } from "./helpers";

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
    plan: "free",
    role: "user",
    createdAt: now,
    updatedAt: now,
  });
}

async function insertPersonalSpace(id: string, ownerId: string) {
  const now = new Date();
  await db.insert(spaces).values({
    kind: "shared",
    id,
    slug: `${id}-slug`,
    name: "Personal Space",
    ownerUserId: ownerId,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(spaceMembers).values({
    id: `mbr_${ownerId}`,
    spaceId: id,
    userId: ownerId,
    role: "admin",
    joinedAt: now,
  });
}

async function insertOrganizationSpace() {
  const now = new Date();
  await db.insert(organizations).values({
    id: "org_1",
    name: "Acme",
    ownerId: "organization_owner",
    plan: "organization",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(spaces).values({
    kind: "shared",
    id: "spc_org",
    slug: "spc_org-slug",
    name: "Organization Space",
    ownerUserId: null,
    organizationId: "org_1",
    createdAt: now,
    updatedAt: now,
  });
}

describe("Space access capabilities", () => {
  it("keeps direct membership separate from authority", async () => {
    await insertUser("owner");
    await insertUser("member");
    await insertPersonalSpace("spc_1", "owner");
    await db.insert(spaceMembers).values({
      id: "mbr_member",
      spaceId: "spc_1",
      userId: "member",
      role: "member",
      joinedAt: new Date(),
    });

    await expect(getSpaceAccess(appDb(), "spc_1", "member")).resolves.toMatchObject({
      directRole: "member",
      organizationRole: null,
      capabilities: { canView: true, canManage: false, canStartMeetings: true },
    });
  });

  it("gives a membership row no ownership of a Space that names someone else", async () => {
    await insertUser("owner");
    await insertUser("impostor");
    await insertPersonalSpace("spc_1", "owner");
    await db.delete(spaceMembers).where(eq(spaceMembers.id, "mbr_owner"));
    await db.insert(spaceMembers).values({
      id: "mbr_impostor",
      spaceId: "spc_1",
      userId: "impostor",
      role: "admin",
      joinedAt: new Date(),
    });

    // An admin manages the Space, but only the member it names is its owner.
    await expect(getSpaceAccess(appDb(), "spc_1", "impostor")).resolves.toMatchObject({
      directRole: "admin",
      capabilities: {
        canView: true,
        canManage: true,
        canGrantAdmins: false,
        canDelete: false,
        canTransferOwnership: false,
      },
    });
  });

  it("does not expose missing or archived Spaces", async () => {
    await insertUser("owner");
    await insertUser("stranger");
    await insertPersonalSpace("spc_1", "owner");

    await expect(
      assertSpaceCapability(appDb(), "spc_1", "stranger", "canView"),
    ).rejects.toThrow();

    await db.update(spaces).set({ archivedAt: new Date() }).where(eq(spaces.id, "spc_1"));
    await expect(
      assertSpaceCapability(appDb(), "spc_1", "owner", "canView"),
    ).rejects.toThrow();
  });

  it("keeps Organization admins governance-only without direct Space membership", async () => {
    await insertUser("organization_owner");
    await insertUser("organization_admin");
    await insertOrganizationSpace();
    await db.insert(organizationMembers).values({
      id: "omb_admin",
      organizationId: "org_1",
      userId: "organization_admin",
      role: "admin",
      joinedAt: new Date(),
    });

    await expect(getSpaceAccess(appDb(), "spc_org", "organization_admin")).resolves.toMatchObject({
      directRole: null,
      organizationRole: "admin",
      capabilities: {
        canView: false,
        canManage: false,
        canDelete: true,
        canTransferOwnership: false,
      },
    });
    await expect(
      assertSpaceCapability(appDb(), "spc_org", "organization_admin", "canView"),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(selectSpacesForUser(appDb(), "organization_admin")).resolves.toEqual([]);
  });

  it("does not turn the Organization owner into a Space viewer", async () => {
    await insertUser("organization_owner");
    await insertOrganizationSpace();

    await expect(getSpaceAccess(appDb(), "spc_org", "organization_owner")).resolves.toMatchObject({
      directRole: null,
      organizationRole: "owner",
      capabilities: {
        canView: false,
        canManage: false,
        canDelete: true,
        canTransferOwnership: false,
      },
    });
  });

  it("preserves direct Space membership as the visibility boundary alongside Organization authority", async () => {
    await insertUser("organization_owner");
    await insertUser("organization_admin");
    await insertOrganizationSpace();
    await db.insert(organizationMembers).values({
      id: "omb_admin",
      organizationId: "org_1",
      userId: "organization_admin",
      role: "admin",
      joinedAt: new Date(),
    });
    await db.insert(spaceMembers).values({
      id: "mbr_admin",
      spaceId: "spc_org",
      userId: "organization_admin",
      role: "member",
      joinedAt: new Date(),
    });

    await expect(getSpaceAccess(appDb(), "spc_org", "organization_admin")).resolves.toMatchObject({
      directRole: "member",
      organizationRole: "admin",
      capabilities: { canView: true, canManage: false, canDelete: true },
    });
  });

  it("lets direct admins of Organization-billed Spaces manage the Space", async () => {
    await insertUser("organization_owner");
    await insertUser("teacher");
    await insertOrganizationSpace();
    await db.insert(organizationMembers).values({
      id: "omb_teacher",
      organizationId: "org_1",
      userId: "teacher",
      role: "member",
      joinedAt: new Date(),
    });
    await db.insert(spaceMembers).values({
      id: "mbr_teacher",
      spaceId: "spc_org",
      userId: "teacher",
      role: "admin",
      joinedAt: new Date(),
    });

    await expect(getSpaceAccess(appDb(), "spc_org", "teacher")).resolves.toMatchObject({
      directRole: "admin",
      organizationRole: "member",
      capabilities: {
        canView: true,
        canManage: true,
        // Granting/revoking the admin role stays with the Organization's owner
        // (mirroring the org module's owner-only rule) — a direct Space admin
        // manages the Space but cannot manufacture peer admins.
        canGrantAdmins: false,
        canStartMeetings: true,
        canDelete: false,
        canLeave: false,
      },
    });

    await insertUser("second_admin");
    await db.insert(spaceMembers).values({
      id: "mbr_second_admin",
      spaceId: "spc_org",
      userId: "second_admin",
      role: "admin",
      joinedAt: new Date(),
    });
    await expect(getSpaceAccess(appDb(), "spc_org", "teacher")).resolves.toMatchObject({
      capabilities: { canLeave: true },
    });
  });
});
