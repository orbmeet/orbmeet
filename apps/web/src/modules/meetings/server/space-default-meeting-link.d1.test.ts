import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { meetingLinks, meetings, organizations, spaceMembers, spaces, users } from "@orbmeet/db/schema";
import { createTestDb, type TestDb } from "@/test/db";
import {ensureSpaceDefaultMeetingLink, replaceSpaceMeetingLinkCode} from "@/modules/meetings/server/space-default-meeting-link.server";

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

async function insertSpace(id = "space_1", ownerId = "owner") {
  const now = new Date();
  await db.insert(spaces).values({
    kind: "shared",
    id,
    slug: `${id}-slug`,
    name: "Project Alpha",
    description: null,
    ownerUserId: ownerId,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(spaceMembers).values({
    id: `mbr_${id}_${ownerId}`,
    spaceId: id,
    userId: ownerId,
    role: "admin",
    joinedAt: now,
  });
}

describe("space default meeting links", () => {
  it("creates one reusable member-guarded default meeting link for a space", async () => {
    await insertUser("owner", "free");
    await insertSpace();

    const defaultMeetingLink = await ensureSpaceDefaultMeetingLink(appDb(), "space_1");
    expect(defaultMeetingLink.code).toMatch(/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/);

    const link = await db.query.meetingLinks.findFirst({ where: { id: defaultMeetingLink.id } });
    expect(link).toMatchObject({
      reusePolicy: "reusable",
      spaceId: "space_1",
      allowGuests: false,
      lastUsedAt: null,
    });
    expect(link?.expiresAt).toBeNull();
  });

  it("is idempotent for repeated default-link ensures", async () => {
    await insertUser("owner", "pro");
    await insertSpace();

    const first = await ensureSpaceDefaultMeetingLink(appDb(), "space_1");
    const second = await ensureSpaceDefaultMeetingLink(appDb(), "space_1");

    expect(second.id).toBe(first.id);
    const allLinks = await db.select({ id: meetingLinks.id }).from(meetingLinks).where(eq(meetingLinks.spaceId, "space_1"));
    expect(allLinks).toHaveLength(1);
  });

  it("adopts an older non-default Space link as the stable default", async () => {
    await insertUser("owner", "pro");
    await insertSpace();
    const now = new Date();
    await db.insert(meetingLinks).values({
      id: "link_existing",
      code: "abc-defg-hij",
      reusePolicy: "reusable",
      spaceId: "space_1",
      spaceKind: "shared" as const,
      title: "Old link",
      // Guest entry is a personal-space capability.
      allowGuests: false,
      joinPolicy: "open",
      lastUsedAt: now,
      expiresAt: new Date(now.getTime() + 86_400_000),
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    const defaultMeetingLink = await ensureSpaceDefaultMeetingLink(appDb(), "space_1");
    expect(defaultMeetingLink.id).toBe("link_existing");

    // The URL identity and user-facing title survive; expiring policy is
    // normalized to the Space's reusable bookmark contract.
    const existing = await db.query.meetingLinks.findFirst({ where: { id: "link_existing" } });
    expect(existing).toMatchObject({
      allowGuests: false,
      title: "Old link",
      reusePolicy: "reusable",
      expiresAt: null,
    });
    const allLinks = await db.select().from(meetingLinks).where(eq(meetingLinks.spaceId, "space_1"));
    expect(allLinks).toHaveLength(1);
  });

  it("never converts an archived one-time link into the Space default", async () => {
    await insertUser("owner", "pro");
    await insertSpace();
    const now = new Date();
    const createdAt = new Date(now.getTime() - 60_000);
    await db.insert(meetingLinks).values({
      id: "link_spent_schedule",
      code: "old-once-url",
      reusePolicy: "one_time",
      spaceId: "space_1",
      spaceKind: "shared" as const,
      title: "Past scheduled meeting",
      allowGuests: false,
      joinPolicy: "open",
      spentAt: now,
      archivedAt: now,
      createdAt,
      updatedAt: now,
    });
    const deadLinkBefore = await db.query.meetingLinks.findFirst({
      where: { id: "link_spent_schedule" },
    });

    const defaultMeetingLink = await ensureSpaceDefaultMeetingLink(appDb(), "space_1");

    expect(defaultMeetingLink.id).not.toBe("link_spent_schedule");
    await expect(db.query.meetingLinks.findFirst({ where: { id: "link_spent_schedule" } }))
      .resolves.toMatchObject({
        reusePolicy: "one_time",
        spentAt: deadLinkBefore?.spentAt,
        archivedAt: deadLinkBefore?.archivedAt,
      });
    await expect(db.query.meetingLinks.findFirst({ where: { id: defaultMeetingLink.id } }))
      .resolves.toMatchObject({ reusePolicy: "reusable", archivedAt: null });
  });

  it("uses a direct Space admin for a missing organization default link", async () => {
    const now = new Date();
    await insertUser("org_owner", "organization");
    await insertUser("teacher", "free");
    await db.insert(organizations).values({
      id: "org_1",
      name: "University",
      ownerId: "org_owner",
      plan: "organization",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(spaces).values({
      kind: "shared",
      id: "space_org",
      slug: "space_org-slug",
      name: "Teacher Room",
      description: null,
      ownerUserId: null,
      organizationId: "org_1",
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(spaceMembers).values({
      id: "mbr_teacher",
      spaceId: "space_org",
      userId: "teacher",
      role: "admin",
      joinedAt: now,
    });

    const defaultMeetingLink = await ensureSpaceDefaultMeetingLink(appDb(), "space_org");

    const link = await db.query.meetingLinks.findFirst({ where: { id: defaultMeetingLink.id } });
    expect(link).toMatchObject({
      reusePolicy: "reusable",
      spaceId: "space_org",
    });
  });

  it("replaces the public code without replacing the durable link identity", async () => {
    await insertUser("owner", "pro");
    await insertSpace();
    const original = await ensureSpaceDefaultMeetingLink(appDb(), "space_1");
    const now = new Date();
    await db.insert(meetings).values({
      id: "meeting_ended",
      meetingLinkId: original.id,
      startedByUserId: "owner",
      billingPrincipalType: "user" as const,
      billingPrincipalId: "owner",
      spaceId: "space_1",
    spaceKind: "shared" as const,
      status: "ended",
    billingPlan: "free",
      allowGuests: false,
      recordingEnabled: false,
      startedAt: new Date(now.getTime() - 60_000),
      endedAt: now,
      updatedAt: now,
    });

    const replacement = await replaceSpaceMeetingLinkCode(appDb(), "space_1", "owner", now);
    expect(replacement.meetingLinkId).toBe(original.id);
    expect(replacement.code).not.toBe(original.code);
    await expect(db.query.meetings.findFirst({ where: { id: "meeting_ended" } }))
      .resolves.toMatchObject({ meetingLinkId: original.id, spaceId: "space_1" });
  });

  it("does not replace the link while the Space meeting is open", async () => {
    await insertUser("owner", "pro");
    await insertSpace();
    const link = await ensureSpaceDefaultMeetingLink(appDb(), "space_1");
    const now = new Date();
    await db.insert(meetings).values({
      id: "meeting_open",
      meetingLinkId: link.id,
      startedByUserId: "owner",
      billingPrincipalType: "user" as const,
      billingPrincipalId: "owner",
      spaceId: "space_1",
    spaceKind: "shared" as const,
      status: "open",
    billingPlan: "free",
      allowGuests: false,
      recordingEnabled: false,
      startedAt: now,
      updatedAt: now,
    });

    await expect(replaceSpaceMeetingLinkCode(appDb(), "space_1", "owner", now))
      .rejects.toThrow(/end the current/i);
    await expect(db.query.meetingLinks.findFirst({ where: { id: link.id } }))
      .resolves.toMatchObject({ code: link.code });
  });

  it("re-checks manager authority in the link update", async () => {
    await insertUser("owner", "pro");
    await insertUser("former_admin", "pro");
    await insertSpace();
    await db.insert(spaceMembers).values({
      id: "mbr_former_admin",
      spaceId: "space_1",
      userId: "former_admin",
      role: "member",
      joinedAt: new Date(),
    });
    const link = await ensureSpaceDefaultMeetingLink(appDb(), "space_1");

    await expect(
      replaceSpaceMeetingLinkCode(appDb(), "space_1", "former_admin", new Date()),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(db.query.meetingLinks.findFirst({ where: { id: link.id } }))
      .resolves.toMatchObject({ code: link.code });
  });

  it("refuses to archive or expire a designated Space default link", async () => {
    // Designated defaults remain durable; replacement changes only their code.
    await insertUser("owner", "pro");
    await insertSpace();
    const link = await ensureSpaceDefaultMeetingLink(appDb(), "space_1");
    const now = new Date();

    await expect(
      db.update(meetingLinks).set({ archivedAt: now, updatedAt: now })
        .where(eq(meetingLinks.id, link.id)),
    ).rejects.toThrow();
    await expect(
      db.update(meetingLinks).set({ expiresAt: now, updatedAt: now })
        .where(eq(meetingLinks.id, link.id)),
    ).rejects.toThrow();

    await expect(db.query.meetingLinks.findFirst({ where: { id: link.id } }))
      .resolves.toMatchObject({ archivedAt: null, expiresAt: null });
  });
});
