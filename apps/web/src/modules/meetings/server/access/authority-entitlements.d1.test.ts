import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { meetings, organizationMembers, organizations, meetingLinks, spaceMembers, spaces, users } from "@orbmeet/db/schema";
import { createTestDb, type TestDb } from "@/test/db";
import { assertPastMeetingManager, canManagePastMeeting } from "./access-assertions";
import { spaceRoleFor } from "../runtime/client.server";
import { resolveMeetingEntitlement } from "@/modules/billing/server/entitlements.server";

let db: TestDb;
const appDb = () => db;

beforeEach(async () => {
  db = await createTestDb();
});

async function insertUser(id: string, plan: "free" | "pro" | "organization" = "free") {
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

async function insertSpaceMeeting() {
  const now = new Date();
  await insertUser("owner", "pro");
  await insertUser("admin");
  await insertUser("member");
  await insertUser("viewer");
  await insertUser("outside");

  await db.insert(spaces).values({
    kind: "shared",
    id: "space_1",
    slug: "space_1-slug",
    name: "Product",
    description: null,
    ownerUserId: "owner",
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(spaceMembers).values([
    { id: "mbr_owner", spaceId: "space_1", userId: "owner", role: "admin", joinedAt: now },
    { id: "mbr_admin", spaceId: "space_1", userId: "admin", role: "admin", joinedAt: now },
    { id: "mbr_member", spaceId: "space_1", userId: "member", role: "member", joinedAt: now },
    { id: "mbr_viewer", spaceId: "space_1", userId: "viewer", role: "member", joinedAt: now },
  ]);
  await db.insert(meetingLinks).values({
    id: "room_1",
    code: "abc-defg-hij",
    reusePolicy: "one_time",
    spaceId: "space_1",
spaceKind: "shared" as const,
    title: "Planning",
    allowGuests: false,
    joinPolicy: "open",
    lastUsedAt: now,
    expiresAt: null,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(meetings).values({
    id: "meeting_1",
    meetingLinkId: "room_1",
    title: "Planning",
    startedByUserId: "member",
    spaceId: "space_1",
    spaceKind: "shared" as const,
    status: "open",
    billingPrincipalType: "user" as const,
    billingPrincipalId: "member",
    billingPlan: "free",
    allowGuests: false,
    recordingEnabled: true,
    joinPolicy: "open",
    activeEgressId: null,
    activeStreamEgressId: null,
    startedAt: now,
    endedAt: null,
    retainUntil: null,
    updatedAt: now,
  });
}

describe("meeting authority and entitlements", () => {
  // Live authority is the meeting room's to decide (runtime/step.ts). What it
  // reads from the Space is `spaceRoleFor`; these pin that reading.
  it("reads the Space's owner and admins as admins, and a starter as the member they are", async () => {
    await insertSpaceMeeting();
    const meeting = { startedByUserId: "member", spaceId: "space_1", spaceKind: "shared" as const };

    await expect(spaceRoleFor(appDb(), meeting, "owner")).resolves.toBe("admin");
    await expect(spaceRoleFor(appDb(), meeting, "admin")).resolves.toBe("admin");
    // Starting a meeting makes nobody a manager; the room lets a starter stand
    // in as host while no manager is present (runtime/model.ts, roleOf).
    await expect(spaceRoleFor(appDb(), meeting, "member")).resolves.toBe("member");
    await expect(spaceRoleFor(appDb(), meeting, "viewer")).resolves.toBe("member");
    await expect(spaceRoleFor(appDb(), meeting, "outside")).resolves.toBe("visitor");
  });

  it("follows a demotion and a removal, the starter's included", async () => {
    await insertSpaceMeeting();
    const meeting = { startedByUserId: "member", spaceId: "space_1", spaceKind: "shared" as const };

    await db.update(spaceMembers).set({ role: "member" }).where(eq(spaceMembers.id, "mbr_admin"));
    await expect(spaceRoleFor(appDb(), meeting, "admin")).resolves.toBe("member");

    await db.delete(spaceMembers).where(eq(spaceMembers.id, "mbr_member"));
    await expect(spaceRoleFor(appDb(), meeting, "member")).resolves.toBe("visitor");
  });

  it("lets only the Space's managers manage a meeting once it has ended", async () => {
    await insertSpaceMeeting();
    await db.update(meetings).set({ status: "ended", endedAt: new Date() }).where(eq(meetings.id, "meeting_1"));
    const meeting = { spaceId: "space_1" };

    await expect(canManagePastMeeting(appDb(), meeting, "owner")).resolves.toBe(true);
    await expect(canManagePastMeeting(appDb(), meeting, "admin")).resolves.toBe(true);
    // Starting it made them its host while it ran; afterwards there is no host.
    await expect(canManagePastMeeting(appDb(), meeting, "member")).resolves.toBe(false);
    await expect(canManagePastMeeting(appDb(), meeting, "viewer")).resolves.toBe(false);
    await expect(canManagePastMeeting(appDb(), meeting, "outside")).resolves.toBe(false);

    await expect(assertPastMeetingManager(appDb(), "meeting_1", "admin")).resolves.toMatchObject({ id: "meeting_1" });
    await expect(assertPastMeetingManager(appDb(), "meeting_1", "member")).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("gives an organization admin no meeting authority without a direct Space row", async () => {
    await insertUser("org_owner", "organization");
    await insertUser("org_admin");
    await insertUser("host");
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
      id: "org_admin_row",
      organizationId: "org_1",
      userId: "org_admin",
      role: "admin",
      joinedAt: now,
    });
    await db.insert(spaces).values({
      kind: "shared",
      id: "space_org",
      slug: "space_org-slug",
      name: "Org Space",
      ownerUserId: null,
      organizationId: "org_1",
      createdAt: now,
      updatedAt: now,
    });
    const meeting = { startedByUserId: "host", spaceId: "space_org", spaceKind: "shared" as const };

    await expect(spaceRoleFor(appDb(), meeting, "org_admin")).resolves.toBe("visitor");
    await expect(canManagePastMeeting(appDb(), meeting, "org_admin")).resolves.toBe(false);

    await db.insert(spaceMembers).values({
      id: "mbr_org_admin",
      spaceId: "space_org",
      userId: "org_admin",
      role: "admin",
      joinedAt: now,
    });

    await expect(spaceRoleFor(appDb(), meeting, "org_admin")).resolves.toBe("admin");
    await expect(canManagePastMeeting(appDb(), meeting, "org_admin")).resolves.toBe(true);
  });

  it("sources space meeting limits and storage billing from the space owner", async () => {
    await insertSpaceMeeting();

    const entitlement = await resolveMeetingEntitlement(appDb(), {
      startedByUserId: "member",
      spaceId: "space_1",
    });

    expect(entitlement).toMatchObject({
      plan: "pro",
      billingUserId: "owner",
      source: "space-owner",
    });
    expect(entitlement.limits.recordingEnabled).toBe(true);
  });

  it("uses the Meeting billing snapshot instead of current Space ownership", async () => {
    await insertSpaceMeeting();

    const entitlement = await resolveMeetingEntitlement(appDb(), {
      startedByUserId: "member",
      spaceId: "space_1",
      billingPrincipalType: "user" as const,
      billingPrincipalId: "member",
      billingPlan: "free",
    });

    expect(entitlement).toMatchObject({
      plan: "free",
      billingUserId: "member",
      source: "meeting-snapshot",
    });
    expect(entitlement.limits.recordingEnabled).toBe(false);
  });

  it("sources organization-owned space limits from the organization", async () => {
    await insertUser("org_owner", "organization");
    await insertUser("org_member", "free");
    const now = new Date();

    await db.insert(organizations).values({
      id: "org_1",
      name: "Acme Studio",
      ownerId: "org_owner",
      plan: "organization",
      licenseLimit: 25,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(organizationMembers).values([
      { id: "omb_owner", organizationId: "org_1", userId: "org_owner", role: "admin", joinedAt: now },
      { id: "omb_member", organizationId: "org_1", userId: "org_member", role: "member", joinedAt: now },
    ]);
    await db.insert(spaces).values({
      kind: "shared",
      id: "space_org",
      slug: "space_org-slug",
      name: "Project Alpha",
      description: null,
      ownerUserId: null,
      organizationId: "org_1",
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    });

    const entitlement = await resolveMeetingEntitlement(appDb(), {
      startedByUserId: "org_member",
      spaceId: "space_org",
    });

    expect(entitlement).toMatchObject({
      plan: "organization",
      billingUserId: "org_owner",
      source: "organization",
    });
    expect(entitlement.limits.maxMembersPerSpace).toBeNull();
  });
});
