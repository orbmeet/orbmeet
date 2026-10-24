import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { meetings, meetingLinks, spaceMembers, spaces, users } from "@orbmeet/db/schema";
import { ONE_TIME_MEETING_LINK_EXPIRY_MS } from "@/modules/meetings/contract/constants";
import { createTestDb, type TestDb } from "@/test/db";
import { seedPersonalSpace, seedSharedSpace } from "@/test/fixtures";
import {insertPersonalMeetingLink} from "@/modules/meetings/server/lifecycle/create.server";
import { acquireMeetingOccurrence, insertMeetingForLinkWithinLimit } from "./lifecycle/meeting-occurrence";

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
  await seedPersonalSpace(getAppDb(), id, { now });
}

describe("insertPersonalMeetingLink", () => {
  // Timestamp columns store whole seconds; a truncated `now` keeps expiry
  // assertions exact.
  const now = new Date("2026-05-02T12:00:00.000Z");

  it("creates the link without starting a meeting", async () => {
    await insertUser("host");

    await insertPersonalMeetingLink(getAppDb(), {
      meetingLinkId: "LINK_1",
      code: "abc-defg-hij",
      spaceId: "host_space",
      spaceKind: "personal" as const,
      title: "Meeting",
      reusePolicy: "one_time",
      allowGuests: true,
      joinPolicy: "open",
      now,
    });

    await expect(db.query.meetingLinks.findFirst({ where: { id: "LINK_1" } })).resolves.toMatchObject({
      id: "LINK_1",
      spaceId: "host_space",
      lastUsedAt: null,
      expiresAt: new Date(now.getTime() + ONE_TIME_MEETING_LINK_EXPIRY_MS),
    });
    await expect(
      db.query.meetings.findFirst({ where: { meetingLinkId: "LINK_1" } }),
    ).resolves.toBeUndefined();
  });

  it("keeps permanent meeting links indefinitely", async () => {
    await insertUser("host");

    await insertPersonalMeetingLink(getAppDb(), {
      meetingLinkId: "LINK_REUSABLE",
      code: "per-mane-ntl",
      spaceId: "host_space",
      spaceKind: "personal" as const,
      title: "Personal link",
      reusePolicy: "reusable",
      allowGuests: true,
      joinPolicy: "open",
      now,
    });

    await expect(
      db.query.meetingLinks.findFirst({ where: { id: "LINK_REUSABLE" } }),
    ).resolves.toMatchObject({ expiresAt: null });
  });
});

describe("insertMeetingForLinkWithinLimit", () => {
  it("creates a link meeting and updates link usage atomically", async () => {
    await insertUser("host");
    const createdAt = new Date("2026-01-01T00:00:00.000Z");
    const startedAt = new Date("2026-01-01T01:00:00.000Z");
    await db.insert(meetingLinks).values({
      id: "LINK_REUSABLE",
      code: "per-mane-ntl",
      reusePolicy: "reusable",
      spaceId: "host_space",
spaceKind: "personal" as const,
      title: "Personal link",
      allowGuests: true,
      joinPolicy: "open",
      createdAt,
      updatedAt: createdAt,
    });

    await expect(
      insertMeetingForLinkWithinLimit(getAppDb(), {
        meetingId: "MEETING_REUSABLE",
        meetingLinkId: "LINK_REUSABLE",
        title: "Personal link",
        startedByUserId: "host",
        billingPrincipal: { type: "user", id: "host" },
        billingPlan: "free",
        spaceId: "host_space",
        spaceKind: "personal" as const,
        allowGuests: true,
        recordingEnabled: false,
        joinPolicy: "open",
        startedAt,
        linkExpiresAt: null,
        maxConcurrentMeetings: 1,
      }),
    ).resolves.toBe(true);

    await expect(
      db.query.meetings.findFirst({
        where: { id: "MEETING_REUSABLE" },
      }),
    ).resolves.toMatchObject({ status: "open", meetingLinkId: "LINK_REUSABLE" });
    await expect(
      db.query.meetingLinks.findFirst({ where: { id: "LINK_REUSABLE" } }),
    ).resolves.toMatchObject({ lastUsedAt: startedAt, updatedAt: startedAt });
  });

  it("starts the meeting transcribing as its starter's account setting says", async () => {
    await insertUser("host");
    const createdAt = new Date("2026-01-01T00:00:00.000Z");
    // One open meeting per link, and one reusable link per personal Space:
    // each start gets a one-time link of its own.
    for (const [id, code] of [["LINK_DEFAULT", "def-ault-lnk"], ["LINK_PRIVATE", "pri-vate-lnk"]]) {
      await db.insert(meetingLinks).values({
        id,
        code,
        reusePolicy: "one_time",
        spaceId: "host_space",
        spaceKind: "personal" as const,
        title: "Personal link",
        allowGuests: true,
        joinPolicy: "open",
        createdAt,
        updatedAt: createdAt,
      });
    }
    const start = (meetingId: string, meetingLinkId: string, startedAt: Date) =>
      insertMeetingForLinkWithinLimit(getAppDb(), {
        meetingId,
        meetingLinkId,
        title: null,
        startedByUserId: "host",
        billingPrincipal: { type: "user", id: "host" },
        billingPlan: "free",
        spaceId: "host_space",
        spaceKind: "personal" as const,
        allowGuests: true,
        recordingEnabled: false,
        joinPolicy: "open",
        startedAt,
        linkExpiresAt: null,
        maxConcurrentMeetings: null,
      });

    // Nobody chose: meetings transcribe, as they always did.
    await expect(start("MEETING_DEFAULT", "LINK_DEFAULT", new Date("2026-01-01T01:00:00.000Z"))).resolves.toBe(true);
    await db.update(users).set({ transcribeMeetings: false }).where(eq(users.id, "host"));
    await expect(start("MEETING_PRIVATE", "LINK_PRIVATE", new Date("2026-01-01T02:00:00.000Z"))).resolves.toBe(true);

    const started = await db.query.meetings.findMany({
      where: { startedByUserId: "host" },
      columns: { id: true, transcriptionEnabled: true },
    });
    expect(Object.fromEntries(started.map((meeting) => [meeting.id, meeting.transcriptionEnabled]))).toEqual({
      MEETING_DEFAULT: true,
      MEETING_PRIVATE: false,
    });
  });

  it("does not start a link meeting after the concurrent limit is reached", async () => {
    await insertUser("host");
    const now = new Date();
    await db.insert(meetingLinks).values([
      {
        id: "LINK_ACTIVE",
        code: "act-ivez-xyz",
        reusePolicy: "one_time",
        spaceId: "host_space", spaceKind: "personal" as const,
        title: "Active",
        allowGuests: true,
        joinPolicy: "open",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "LINK_REUSABLE",
        code: "prm-room-ntz",
        reusePolicy: "reusable",
        spaceId: "host_space", spaceKind: "personal" as const,
        title: "Personal link",
        allowGuests: true,
        joinPolicy: "open",
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await db.insert(meetings).values({
      id: "MEETING_ACTIVE",
      meetingLinkId: "LINK_ACTIVE",
      spaceId: "host_space",
      spaceKind: "personal" as const,
      startedByUserId: "host",
      billingPrincipalType: "user" as const,
      billingPrincipalId: "host",
      status: "open",
      billingPlan: "free",
      allowGuests: true,
      startedAt: now,
      updatedAt: now,
    });

    await expect(
      insertMeetingForLinkWithinLimit(getAppDb(), {
        meetingId: "MEETING_BLOCKED",
        meetingLinkId: "LINK_REUSABLE",
        title: "Personal link",
        startedByUserId: "host",
        billingPrincipal: { type: "user", id: "host" },
        billingPlan: "free",
        spaceId: "host_space",
        spaceKind: "personal" as const,
        allowGuests: true,
        recordingEnabled: false,
        joinPolicy: "open",
        startedAt: new Date(now.getTime() + 60_000),
        linkExpiresAt: null,
        maxConcurrentMeetings: 1,
      }),
    ).resolves.toBe(false);

    await expect(
      db.query.meetings.findFirst({
        where: { id: "MEETING_BLOCKED" },
      }),
    ).resolves.toBeUndefined();
    await expect(
      db.query.meetingLinks.findFirst({ where: { id: "LINK_REUSABLE" } }),
    ).resolves.toMatchObject({ lastUsedAt: null });
  });

  it("counts concurrent meetings against the billing principal, not the starter", async () => {
    await Promise.all([insertUser("billing-owner"), insertUser("starter-a"), insertUser("starter-b")]);
    const now = new Date();
    await db.insert(meetingLinks).values([
      {
        id: "LINK_BILLED_ACTIVE",
        code: "bil-leda-ctv",
        reusePolicy: "one_time",
        spaceId: "starter-a_space", spaceKind: "personal" as const,
        allowGuests: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "LINK_BILLED_NEXT",
        code: "bil-ledn-ext",
        reusePolicy: "one_time",
        spaceId: "starter-b_space", spaceKind: "personal" as const,
        allowGuests: true,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await db.insert(meetings).values({
      id: "MEETING_BILLED_ACTIVE",
      meetingLinkId: "LINK_BILLED_ACTIVE",
      spaceId: "starter-a_space",
      spaceKind: "personal" as const,
      startedByUserId: "starter-a",
      billingPrincipalType: "user" as const,
      billingPrincipalId: "billing-owner",
      billingPlan: "pro",
      status: "open",
      allowGuests: true,
      startedAt: now,
      updatedAt: now,
    });

    await expect(
      insertMeetingForLinkWithinLimit(getAppDb(), {
        meetingId: "MEETING_BILLED_BLOCKED",
        meetingLinkId: "LINK_BILLED_NEXT",
        title: null,
        startedByUserId: "starter-b",
        billingPrincipal: { type: "user", id: "billing-owner" },
        billingPlan: "pro",
        spaceId: "starter-b_space",
        spaceKind: "personal" as const,
        allowGuests: true,
        recordingEnabled: false,
        joinPolicy: "open",
        startedAt: new Date(now.getTime() + 1_000),
        linkExpiresAt: null,
        maxConcurrentMeetings: 1,
      }),
    ).resolves.toBe(false);
  });

  it("refuses to start a second occurrence for a consumed one-time link", async () => {
    await insertUser("host");
    const now = new Date();
    await db.insert(meetingLinks).values({
      id: "LINK_ONE_TIME",
      code: "one-time-xyz",
      reusePolicy: "one_time",
      spaceId: "host_space",
spaceKind: "personal" as const,
      title: "One time",
      allowGuests: true,
      joinPolicy: "open",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(meetings).values({
      id: "MEETING_ENDED",
      meetingLinkId: "LINK_ONE_TIME",
      spaceId: "host_space",
      spaceKind: "personal" as const,
      startedByUserId: "host",
      status: "ended",
      billingPrincipalType: "user" as const,
      billingPrincipalId: "host",
      billingPlan: "free",
      allowGuests: true,
      recordingEnabled: false,
      startedAt: new Date(now.getTime() - 60_000),
      endedAt: now,
      updatedAt: now,
    });

    await expect(
      insertMeetingForLinkWithinLimit(getAppDb(), {
        meetingId: "MEETING_SECOND",
        meetingLinkId: "LINK_ONE_TIME",
        title: "One time",
        startedByUserId: "host",
        billingPrincipal: { type: "user", id: "host" },
        billingPlan: "free",
        spaceId: "host_space",
        spaceKind: "personal" as const,
        allowGuests: true,
        recordingEnabled: false,
        joinPolicy: "open",
        startedAt: new Date(now.getTime() + 1000),
        linkExpiresAt: null,
        maxConcurrentMeetings: null,
        requireLinkUnused: true,
      }),
    ).resolves.toBe(false);

    await expect(
      db.query.meetings.findFirst({ where: { id: "MEETING_SECOND" } }),
    ).resolves.toBeUndefined();
  });

  it("does not start an occurrence after account deletion archives the link", async () => {
    await insertUser("host");
    const now = new Date();
    await db.insert(meetingLinks).values({
      id: "LINK_DELETION_BARRIER",
      code: "del-eteb-arr",
      reusePolicy: "reusable",
      spaceId: "host_space",
spaceKind: "personal" as const,
      allowGuests: true,
      createdAt: now,
      updatedAt: now,
      archivedAt: now,
    });

    await expect(
      insertMeetingForLinkWithinLimit(getAppDb(), {
        meetingId: "MEETING_AFTER_DELETE",
        meetingLinkId: "LINK_DELETION_BARRIER",
        title: null,
        startedByUserId: "host",
        billingPrincipal: { type: "user", id: "host" },
        billingPlan: "free",
        spaceId: "host_space",
        spaceKind: "personal" as const,
        allowGuests: true,
        recordingEnabled: false,
        joinPolicy: "open",
        startedAt: new Date(now.getTime() + 1_000),
        linkExpiresAt: null,
        maxConcurrentMeetings: null,
      }),
    ).resolves.toBe(false);
  });

  it("does not start a default-link meeting after its Space is archived", async () => {
    await insertUser("host");
    const now = new Date();
    await db.insert(spaces).values({
      id: "SPACE_ARCHIVED",
      kind: "shared",
      name: "Archived",
      ownerUserId: "host",
      slug: "archived",
      archivedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(spaceMembers).values({
      id: "MEMBER_HOST",
      spaceId: "SPACE_ARCHIVED",
      userId: "host",
      role: "admin",
      joinedAt: now,
    });
    await db.insert(meetingLinks).values({
      id: "LINK_ARCHIVED",
      code: "arc-hive-dxx",
      reusePolicy: "reusable",
      spaceId: "SPACE_ARCHIVED",
spaceKind: "shared" as const,
      title: "Archived",
      allowGuests: false,
      joinPolicy: "open",
      archivedAt: now,
      createdAt: now,
      updatedAt: now,
    });

    await expect(
      insertMeetingForLinkWithinLimit(getAppDb(), {
        meetingId: "MEETING_BLOCKED",
        meetingLinkId: "LINK_ARCHIVED",
        title: "Archived",
        startedByUserId: "host",
        billingPrincipal: { type: "user", id: "host" },
        billingPlan: "free",
        spaceId: "SPACE_ARCHIVED",
        spaceKind: "shared" as const,
        allowGuests: false,
        recordingEnabled: false,
        joinPolicy: "open",
        startedAt: new Date(now.getTime() + 1000),
        linkExpiresAt: null,
        maxConcurrentMeetings: null,
      }),
    ).resolves.toBe(false);
  });

  it("does not start another occurrence while its Space already has one open", async () => {
    await insertUser("host");
    const now = new Date();
    await db.insert(spaces).values({
      id: "SPACE_ONE_AT_A_TIME",
      kind: "shared",
      name: "Design",
      ownerUserId: "host",
      slug: "design",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(meetingLinks).values({
      id: "SPACE_LINK_ACTIVE",
      code: "act-ivea-one",
      reusePolicy: "reusable",
      spaceId: "SPACE_ONE_AT_A_TIME",
      spaceKind: "shared" as const,
      allowGuests: false,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(meetings).values({
      id: "SPACE_MEETING_ACTIVE",
      meetingLinkId: "SPACE_LINK_ACTIVE",
      startedByUserId: "host",
      billingPrincipalType: "user" as const,
      billingPrincipalId: "host",
      billingPlan: "free",
      spaceId: "SPACE_ONE_AT_A_TIME",
      spaceKind: "shared" as const,
      status: "open",
      allowGuests: false,
      startedAt: now,
      updatedAt: now,
    });

    await expect(insertMeetingForLinkWithinLimit(getAppDb(), {
      meetingId: "SPACE_MEETING_BLOCKED",
      meetingLinkId: "SPACE_LINK_ACTIVE",
      title: null,
      startedByUserId: "host",
      billingPrincipal: { type: "user", id: "host" },
      billingPlan: "free",
      spaceId: "SPACE_ONE_AT_A_TIME",
      spaceKind: "shared" as const,
      allowGuests: false,
      recordingEnabled: false,
      joinPolicy: "open",
      startedAt: new Date(now.getTime() + 1_000),
      linkExpiresAt: null,
      maxConcurrentMeetings: null,
    })).resolves.toBe(false);
  });
  it("opens nothing for a starter no longer in the Space", async () => {
    await insertUser("owner");
    await insertUser("removed");
    const now = new Date("2026-01-01T00:00:00.000Z");
    await seedSharedSpace(getAppDb(), {
      id: "space_team",
      ownerUserId: "owner",
      now,
      members: [{ userId: "owner", role: "owner" }],
    });
    await db.insert(meetingLinks).values({
      id: "LINK_TEAM",
      code: "tea-mlin-kab",
      reusePolicy: "reusable",
      spaceId: "space_team",
      spaceKind: "shared" as const,
      title: "Team",
      allowGuests: false,
      joinPolicy: "open",
      createdAt: now,
      updatedAt: now,
    });
    const start = (meetingId: string, startedByUserId: string) =>
      insertMeetingForLinkWithinLimit(getAppDb(), {
        meetingId,
        meetingLinkId: "LINK_TEAM",
        title: null,
        startedByUserId,
        billingPrincipal: { type: "user", id: "owner" },
        billingPlan: "free",
        spaceId: "space_team",
        spaceKind: "shared" as const,
        allowGuests: false,
        recordingEnabled: false,
        joinPolicy: "open",
        startedAt: now,
        linkExpiresAt: null,
        maxConcurrentMeetings: null,
      });

    // Authorized a moment ago, removed before the insert ran.
    await expect(start("MEETING_REMOVED", "removed")).resolves.toBe(false);
    await expect(db.query.meetings.findFirst({ where: { id: "MEETING_REMOVED" } })).resolves.toBeUndefined();
    await expect(start("MEETING_OWNER", "owner")).resolves.toBe(true);
  });
});

describe("acquireMeetingOccurrence", () => {
  it("starts an independent Meeting for a new personal link", async () => {
    await insertUser("host");
    const now = new Date();
    await db.insert(meetingLinks).values([
      {
        id: "LINK_ALREADY_OPEN",
        code: "old-room-now",
        reusePolicy: "reusable",
        spaceId: "host_space",
        spaceKind: "personal" as const,
        title: "Existing personal link",
        allowGuests: true,
        joinPolicy: "open",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "LINK_NEW_ONE_TIME",
        code: "new-room-now",
        reusePolicy: "one_time",
        spaceId: "host_space",
        spaceKind: "personal" as const,
        title: null,
        allowGuests: true,
        joinPolicy: "open",
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await db.insert(meetings).values({
      id: "MEETING_ALREADY_OPEN",
      meetingLinkId: "LINK_ALREADY_OPEN",
      startedByUserId: "host",
      billingPrincipalType: "user" as const,
      billingPrincipalId: "host",
      billingPlan: "pro",
      spaceId: "host_space",
      spaceKind: "personal" as const,
      status: "open",
      allowGuests: true,
      recordingEnabled: true,
      joinPolicy: "open",
      startedAt: now,
      updatedAt: now,
    });

    const result = await acquireMeetingOccurrence(getAppDb(), {
      meetingLink: {
        id: "LINK_NEW_ONE_TIME",
        reusePolicy: "one_time",
        isSpaceDefault: false,
        spaceId: "host_space",
        title: null,
        allowGuests: true,
        joinPolicy: "open",
        expiresAt: null,
      },
      existingMeeting: null,
      starter: { id: "host" },
      entitlement: {
        billingPrincipal: { type: "user", id: "host" },
        plan: "pro",
        limits: {
          recordingEnabled: true,
          maxConcurrentMeetings: 5,
        },
      },
    });

    expect(result.createdMeetingId).not.toBeNull();
    expect(result.meeting).toMatchObject({
      spaceId: "host_space",
    });
    expect(result.meeting.id).not.toBe("MEETING_ALREADY_OPEN");
    await expect(db.query.meetings.findFirst({
      where: { id: result.meeting.id },
    })).resolves.toMatchObject({
      meetingLinkId: "LINK_NEW_ONE_TIME",
      spaceId: "host_space",
    });
  });

  it("does not store the Space or default Link name as the Meeting title", async () => {
    await insertUser("host");
    const now = new Date();
    await db.insert(spaces).values({
      id: "SPACE_TITLE",
      kind: "shared",
      name: "Current Space name",
      ownerUserId: "host",
      slug: "current-space",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(spaceMembers).values({
      id: "MEMBER_TITLE",
      spaceId: "SPACE_TITLE",
      userId: "host",
      role: "admin",
      joinedAt: now,
    });
    await db.insert(meetingLinks).values({
      id: "SPACE_LINK_TITLE",
      code: "spc-titl-now",
      spaceId: "SPACE_TITLE",
spaceKind: "shared" as const,
      reusePolicy: "reusable",
      title: "Stale Link title",
      allowGuests: false,
      joinPolicy: "open",
      createdAt: now,
      updatedAt: now,
    });

    const result = await acquireMeetingOccurrence(getAppDb(), {
      meetingLink: {
        id: "SPACE_LINK_TITLE",
        reusePolicy: "reusable",
        isSpaceDefault: true,
        spaceId: "SPACE_TITLE",
        title: "Stale Link title",
        allowGuests: false,
        joinPolicy: "open",
        expiresAt: null,
      },
      existingMeeting: null,
      starter: { id: "host" },
      entitlement: {
        billingPrincipal: { type: "user", id: "host" },
        plan: "free",
        limits: {
          recordingEnabled: false,
          maxConcurrentMeetings: 1,
        },
      },
    });

    expect(result.meeting.title).toBeNull();
  });
});
