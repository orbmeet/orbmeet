import { beforeEach, describe, expect, it } from "vitest";

import {
  meetingLinks,
  meetings,
  spaceMembers,
  spaces,
  users,
} from "@orbmeet/db/schema";
import { eq } from "drizzle-orm";

import { selectMeetingLookupByCode } from "@/modules/meetings/server/history/meeting-lookup.server";

import {
  acquireMeetingOccurrence,
  insertMeetingForLinkWithinLimit,
} from "@/modules/meetings/server/lifecycle/meeting-occurrence";

import {
  cancelMeetingScheduleRecord,
} from "./commands";
import { createMeetingScheduleForUser } from "./creation";

import { type TestDb } from "@/test/db";

import {
  createFixture,
  organizer,
  seedScheduleUsers,
} from "@/test/commands-test-support";

let db: TestDb;

beforeEach(async () => {
  db = await seedScheduleUsers();
});

describe("Scheduled meeting commands: the occurrence and canceling", () => {
  it("never archives a scheduled link after its occurrence wins the start race", async () => {
    const created = await createFixture(db);
    const scheduledLink = await db.query.meetingLinks.findFirst({
      where: { id: created.meetingLinkId },
      columns: { spaceId: true },
    });
    const startsAt = new Date("2026-07-16T09:00:00.000Z");
    await Promise.allSettled([
      insertMeetingForLinkWithinLimit(db, {
        meetingId: "mtg_start_cancel_race",
        meetingLinkId: created.meetingLinkId,
        title: "Planning with Maruf",
        startedByUserId: organizer.id,
        billingPrincipal: { type: "user", id: organizer.id },
        billingPlan: "pro",
        spaceId: scheduledLink!.spaceId,
        spaceKind: "personal" as const,
        allowGuests: true,
        recordingEnabled: true,
        joinPolicy: "approval_required",
        startedAt: startsAt,
        linkExpiresAt: new Date("2026-07-17T09:45:00.000Z"),
        maxConcurrentMeetings: null,
        requireLinkUnused: true,
      }),
      cancelMeetingScheduleRecord(
        db,
        organizer.id,
        {
          scheduleId: created.id,
          expectedRevision: 1,
        },
        startsAt,
      ),
    ]);

    const [schedule, link, occurrence] = await Promise.all([
      db.query.meetingSchedules.findFirst({ where: { id: created.id } }),
      db.query.meetingLinks.findFirst({ where: { id: created.meetingLinkId } }),
      db.query.meetings.findFirst({ where: { id: "mtg_start_cancel_race" } }),
    ]);
    expect(Boolean(schedule?.canceledAt)).not.toBe(Boolean(occurrence));
    expect(occurrence ? link?.archivedAt : null).toBeNull();
  });

  it("cancels atomically, archives the room, and makes lookup return not found", async () => {
    const created = await createFixture(db);
    const canceledAt = new Date("2026-07-14T11:00:00.000Z");
    await cancelMeetingScheduleRecord(
      db,
      organizer.id,
      {
        scheduleId: created.id,
        expectedRevision: 1,
        reason: "Plans changed",
      },
      canceledAt,
    );

    await expect(
      db.query.meetingSchedules.findFirst({ where: { id: created.id } }),
    ).resolves.toMatchObject({
      revision: 2,
      canceledAt,
      canceledByUserId: organizer.id,
      cancelReason: "Plans changed",
    });
    await expect(
      db.query.meetingLinks.findFirst({ where: { id: created.meetingLinkId } }),
    ).resolves.toMatchObject({
      archivedAt: canceledAt,
    });
    await expect(selectMeetingLookupByCode(db, created.code, organizer.id)).resolves.toEqual({
      exists: false,
    });
  });

  it("prevents rescheduling or canceling after the occurrence has started", async () => {
    const created = await createFixture(db);
    const scheduledLink = await db.query.meetingLinks.findFirst({
      where: { id: created.meetingLinkId },
      columns: { spaceId: true },
    });
    const startedAt = new Date("2026-07-16T09:00:00.000Z");
    await db.insert(meetings).values({
      id: "mtg_scheduled_started",
      meetingLinkId: created.meetingLinkId,
      title: "Planning with Maruf",
      startedByUserId: organizer.id,
      spaceId: scheduledLink!.spaceId,
      spaceKind: "personal" as const,
      status: "open",
      billingPrincipalType: "user" as const,
      billingPrincipalId: organizer.id,
      billingPlan: "free",
      allowGuests: true,
      recordingEnabled: true,
      joinPolicy: "approval_required",
      startedAt,
      updatedAt: startedAt,
    });

    await expect(
      cancelMeetingScheduleRecord(
        db,
        organizer.id,
        { scheduleId: created.id, expectedRevision: 1 },
        new Date("2026-07-16T09:01:00.000Z"),
      ),
    ).rejects.toThrow(/already started/i);
  });


  it("starts a scheduled Space occurrence for a current member but keeps management with admins", async () => {
    const runtimeNow = new Date();
    runtimeNow.setMilliseconds(0);
    const member = {
      id: "usr_space_member",
      name: "Space Member",
      email: "space-member@example.com",
      normalizedEmail: "space-member@example.com",
      image: null,
      plan: "free" as const,
      role: "user" as const,
      createdAt: runtimeNow,
      updatedAt: runtimeNow,
    };
    await db.insert(users).values(member);
    await db.insert(spaces).values({
      kind: "shared",
      id: "spc_startable",
      name: "Startable Class",
      ownerUserId: organizer.id,
      slug: "startable-class",
      createdAt: runtimeNow,
      updatedAt: runtimeNow,
    });
    await db.insert(spaceMembers).values([
      {
        id: "spm_start_owner",
        spaceId: "spc_startable",
        userId: organizer.id,
        role: "admin",
        joinedAt: runtimeNow,
      },
      {
        id: "spm_start_member",
        spaceId: "spc_startable",
        userId: member.id,
        role: "member",
        joinedAt: runtimeNow,
      },
    ]);
    const created = await createMeetingScheduleForUser(db, organizer, {
      startsAt: new Date(runtimeNow.getTime() + 2 * 60_000).toISOString(),
      durationMinutes: 30,
      timeZone: "UTC",
      spaceId: "spc_startable",
      attendees: [],
      joinPolicy: "open",
    });
    const link = await db.query.meetingLinks.findFirst({ where: { id: created.meetingLinkId } });
    expect(link).toBeDefined();

    const acquired = await acquireMeetingOccurrence(db, {
      meetingLink: { ...link!, isSpaceDefault: true },
      existingMeeting: null,
      starter: { id: member.id },
      entitlement: {
        billingPrincipal: { type: "user", id: organizer.id },
        plan: "pro",
        limits: {
          recordingEnabled: true,
          maxConcurrentMeetings: 2,
        },
      },
    });
    expect(acquired.createdMeetingId).not.toBeNull();
    expect(acquired.meeting).toMatchObject({
      spaceId: "spc_startable",
      startedByUserId: member.id,
      title: "Startable Class meeting",
    });
    await expect(
      db.query.meetingSchedules.findFirst({ where: { id: created.id } }),
    ).resolves.toMatchObject({ meetingId: acquired.meeting.id });
    // Claiming the schedule records its organizer, who stands in as host while
    // no Space admin is present — not the member who happened to open it.
    await expect(
      db.query.meetings.findFirst({ where: { id: acquired.meeting.id } }),
    ).resolves.toMatchObject({ startedByUserId: member.id, organizerUserId: organizer.id });

    await expect(
      cancelMeetingScheduleRecord(db, organizer.id, {
        scheduleId: created.id,
        expectedRevision: 1,
      }),
    ).rejects.toThrow(/already started/i);

    const storedLink = await db
      .select()
      .from(meetingLinks)
      .where(eq(meetingLinks.id, created.meetingLinkId));
    expect(storedLink[0]?.archivedAt).toBeNull();
  });
});
