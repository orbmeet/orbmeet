import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  meetingLinks,
  meetingScheduleAttendees,
  meetingScheduleNotifications,
  spaceMembers,
  spaces,
  userContacts,
  users,
} from "@orbmeet/db/schema";
import { eq } from "drizzle-orm";

import { boundedStatements } from "@/platform/database/db-batching";

import { selectMeetingLookupByCode } from "@/modules/meetings/server/history/meeting-lookup.server";

import { rememberInvitedContacts } from "@/modules/contacts/server/contact-index";

import {
  cancelMeetingScheduleRecord,
  createMeetingScheduleRecord,
  rescheduleMeetingScheduleRecord,
} from "./commands";
import { createMeetingScheduleForUser } from "./creation";
import {
  listMeetingSchedulesPageForUser,
  resolveManageableMeetingScheduleForUser,
} from "@/modules/scheduling/server/queries.server";

import { type TestDb } from "@/test/db";

import {
  createFixture,
  insertSpaceScheduleFixture,
  listSchedules,
  now,
  organizer,
  pinClock,
  seedScheduleUsers,
} from "@/test/commands-test-support";

let db: TestDb;

beforeEach(async () => {
  db = await seedScheduleUsers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Scheduled meeting commands: creating", () => {
  it("creates a Space schedule with more than 100 distinct invitees", async () => {
    const link = await insertSpaceScheduleFixture(db);
    const invitees = Array.from({ length: 101 }, (_, index) => ({
      id: `usr_space_attendee_${index}`,
      name: `Space attendee ${index}`,
      email: `attendee${index}@example.com`,
      normalizedEmail: `attendee${index}@example.com`,
      plan: "free" as const,
      role: "user" as const,
      createdAt: now,
      updatedAt: now,
    }));
    for (const insert of boundedStatements(invitees, (rows) => db.insert(users).values(rows))) {
      await insert;
    }
    const memberships = invitees.map((user, index) => ({
      id: `spm_space_attendee_${index}`,
      spaceId: "spc_no_overlap",
      userId: user.id,
      role: "member" as const,
      joinedAt: now,
    }));
    for (const insert of boundedStatements(memberships, (rows) => db.insert(spaceMembers).values(rows))) {
      await insert;
    }
    const created = await createMeetingScheduleRecord(
      db,
      organizer,
      {
        spaceId: "spc_no_overlap",
        attendees: invitees.map(({ email }) => ({ email })),
        startsAt: new Date(now.getTime() + 86_400_000).toISOString(),
        durationMinutes: 30,
        timeZone: "UTC",
        joinPolicy: "open",
      },
      { now, spaceMeetingLink: link },
    );
    expect(created.attendeeCount).toBe(101);
    expect(
      await db.query.meetingScheduleAttendees.findMany({ where: { scheduleId: created.id } }),
    ).toHaveLength(101);
  });

  it("does not reintroduce a Space member who left after roster resolution", async () => {
    const link = await insertSpaceScheduleFixture(db);
    await db.insert(spaceMembers).values({
      id: "spm_departed_before_commit",
      spaceId: "spc_no_overlap",
      userId: "usr_maruf",
      role: "member",
      joinedAt: now,
    });
    const staleRoster = [{ email: "Maruf@Example.com", displayName: "Maruf" }];
    await db.delete(spaceMembers).where(eq(spaceMembers.id, "spm_departed_before_commit"));

    const created = await createMeetingScheduleRecord(
      db,
      organizer,
      {
        spaceId: "spc_no_overlap",
        attendees: staleRoster,
        startsAt: new Date(now.getTime() + 86_400_000).toISOString(),
        durationMinutes: 30,
        timeZone: "UTC",
        joinPolicy: "open",
      },
      { now, spaceMeetingLink: link },
    );

    expect(created.attendeeCount).toBe(0);
    expect(
      await db.query.meetingScheduleAttendees.findMany({
        where: { scheduleId: created.id },
      }),
    ).toEqual([]);
    expect(
      await db.query.meetingScheduleNotifications.findMany({
        where: { scheduleId: created.id },
      }),
    ).toEqual([]);
  });

  it("exposes known invitee details only to the organizer of a personal schedule", async () => {
    const created = await createFixture(db);
    await rememberInvitedContacts(db, organizer, [{ email: "maruf@example.com" }]);

    const [organizerView] = await listSchedules(db, organizer, now);
    // The personal space is not addressable as a space in client payloads.
    expect(organizerView).toMatchObject({ id: created.id, spaceId: null, spaceName: null });
    expect(organizerView?.attendees).toEqual(
      expect.arrayContaining([expect.objectContaining({ email: "maruf@example.com" })]),
    );

    const [attendeeView] = await listSchedules(
      db,
      { id: "usr_maruf", email: "maruf@example.com" },
      now,
    );
    expect(attendeeView).toMatchObject({ id: created.id, attendees: [] });
    expect(attendeeView?.attendeeCount).toBeGreaterThan(0);
  });

  it("atomically creates a scheduled one-time link, deduplicated attendees, and delivery work", async () => {
    const created = await createFixture(db);

    await expect(
      db.query.meetingSchedules.findFirst({ where: { id: created.id } }),
    ).resolves.toMatchObject({
      meetingLinkId: created.meetingLinkId,
      organizerUserId: organizer.id,
      revision: 1,
      startsAt: new Date("2026-07-16T09:00:00.000Z"),
      endsAt: new Date("2026-07-16T09:45:00.000Z"),
      timeZone: "Asia/Dhaka",
    });
    await expect(
      db.query.meetingLinks.findFirst({ where: { id: created.meetingLinkId } }),
    ).resolves.toMatchObject({
      code: created.code,
      reusePolicy: "one_time",
      expiresAt: new Date("2026-07-17T09:45:00.000Z"),
      joinPolicy: "approval_required",
    });
    await expect(db.select().from(meetingScheduleAttendees)).resolves.toMatchObject([
      { scheduleId: created.id, userId: "usr_maruf", normalizedEmail: "maruf@example.com" },
    ]);
    await expect(db.select().from(meetingScheduleNotifications)).resolves.toMatchObject([
      { scheduleId: created.id, kind: "invitation", revision: 1, status: "pending" },
    ]);
  });


  it("schedules on an owned permanent personal link without consuming or canceling it", async () => {
    await db.insert(spaces).values({
      id: "spc_personal_schedule",
      kind: "personal",
      name: "Schedule Host's personal space",
      ownerUserId: organizer.id,
      slug: null,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(spaceMembers).values({
      id: "spm_personal_schedule_owner",
      spaceId: "spc_personal_schedule",
      userId: organizer.id,
      role: "admin",
      joinedAt: now,
    });
    await db.insert(meetingLinks).values({
      id: "link_personal_schedule",
      code: "tut-oria-lnk",
      spaceId: "spc_personal_schedule",
      spaceKind: "personal",
      reusePolicy: "reusable",
      title: "Math tutoring",
      allowGuests: true,
      joinPolicy: "approval_required",
      createdAt: now,
      updatedAt: now,
    });
    pinClock();

    const created = await createMeetingScheduleForUser(db, organizer, {
      meetingLinkId: "link_personal_schedule",
      startsAt: "2026-07-16T09:00:00.000Z",
      durationMinutes: 45,
      timeZone: "Asia/Dhaka",
      attendees: [{ email: "maruf@example.com" }],
      joinPolicy: "approval_required",
      reminderMinutesBefore: 60,
    });

    expect(created).toMatchObject({
      meetingLinkId: "link_personal_schedule",
      code: "tut-oria-lnk",
      title: "Math tutoring",
    });
    await expect(selectMeetingLookupByCode(db, created.code, organizer.id)).resolves.toMatchObject({
      exists: true,
      canStartMeeting: true,
      scheduledNotOpenYet: false,
    });
    await expect(
      createMeetingScheduleForUser(db, organizer, {
        meetingLinkId: "link_personal_schedule",
        startsAt: "2026-07-16T09:30:00.000Z",
        durationMinutes: 45,
        timeZone: "Asia/Dhaka",
        attendees: [],
        joinPolicy: "open",
        reminderMinutesBefore: null,
      }),
    ).rejects.toThrow(/already scheduled/i);

    await createMeetingScheduleForUser(db, organizer, {
      meetingLinkId: "link_personal_schedule",
      startsAt: "2026-07-16T11:00:00.000Z",
      durationMinutes: 45,
      timeZone: "Asia/Dhaka",
      attendees: [],
      joinPolicy: "open",
      reminderMinutesBefore: null,
    });
    await expect(
      rescheduleMeetingScheduleRecord(
        db,
        organizer.id,
        {
          scheduleId: created.id,
          expectedRevision: 1,
          startsAt: "2026-07-16T11:15:00.000Z",
          durationMinutes: 45,
          timeZone: "Asia/Dhaka",
          reminderMinutesBefore: 30,
        },
        new Date("2026-07-14T11:00:00.000Z"),
      ),
    ).rejects.toThrow(/already scheduled/i);

    await cancelMeetingScheduleRecord(
      db,
      organizer.id,
      {
        scheduleId: created.id,
        expectedRevision: 1,
      },
      new Date("2026-07-14T11:00:00.000Z"),
    );
    await expect(
      db.query.meetingLinks.findFirst({ where: { id: "link_personal_schedule" } }),
    ).resolves.toMatchObject({ archivedAt: null, spentAt: null, reusePolicy: "reusable" });
  });


  it("enforces the attendee limit after all automation targets are combined", async () => {
    pinClock();
    await expect(
      createMeetingScheduleForUser(db, organizer, {
        startsAt: "2026-07-16T09:00:00.000Z",
        durationMinutes: 30,
        timeZone: "UTC",
        attendees: Array.from({ length: 11 }, (_, index) => ({
          email: `guest${index}@example.com`,
        })),
        joinPolicy: "open",
      }),
    ).rejects.toThrow(/at most 10/i);
  });


  it("keeps a generated schedule title within the DB limit for a long Space name", async () => {
    pinClock();
    await db.insert(spaces).values({
      kind: "shared",
      id: "spc_long_name",
      name: "x".repeat(200),
      ownerUserId: organizer.id,
      slug: "long-name",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(spaceMembers).values({
      id: "spm_long_name_owner",
      spaceId: "spc_long_name",
      userId: organizer.id,
      role: "admin",
      joinedAt: now,
    });

    const created = await createMeetingScheduleForUser(db, organizer, {
      startsAt: "2026-07-16T09:00:00.000Z",
      durationMinutes: 60,
      timeZone: "Asia/Dhaka",
      spaceId: "spc_long_name",
      attendees: [],
      joinPolicy: "open",
    });
    const schedule = await db.query.meetingSchedules.findFirst({
      where: { id: created.id },
      columns: { title: true },
    });
    expect(schedule?.title).toBe(`${"x".repeat(192)} meeting`);
    expect(schedule?.title?.length).toBe(200);
  });

  it("creates a Space-scoped schedule and invites every member in bounded inserts", async () => {
    pinClock();
    const memberUsers = Array.from({ length: 12 }, (_, index) => ({
      id: `usr_class_${index}`,
      name: `Student ${index}`,
      email: `student${index}@example.com`,
      normalizedEmail: `student${index}@example.com`,
      image: null,
      plan: "free" as const,
      role: "user" as const,
      createdAt: now,
      updatedAt: now,
    }));
    for (const insert of boundedStatements(memberUsers, (chunk) => db.insert(users).values(chunk))) {
      await insert;
    }
    await db.insert(spaces).values({
      kind: "shared",
      id: "spc_math_201",
      name: "Math 201 Class",
      ownerUserId: organizer.id,
      slug: "math-201-class",
      createdAt: now,
      updatedAt: now,
    });
    const members = [
      {
        id: "spm_math_owner",
        spaceId: "spc_math_201",
        userId: organizer.id,
        role: "admin" as const,
        joinedAt: now,
      },
      ...memberUsers.map((user, index) => ({
        id: `spm_math_${index}`,
        spaceId: "spc_math_201",
        userId: user.id,
        role: "member" as const,
        joinedAt: now,
      })),
    ];
    for (const insert of boundedStatements(members, (chunk) => db.insert(spaceMembers).values(chunk))) {
      await insert;
    }

    const created = await createMeetingScheduleForUser(db, organizer, {
      startsAt: "2026-07-16T09:00:00.000Z",
      durationMinutes: 60,
      timeZone: "Asia/Dhaka",
      spaceId: "spc_math_201",
      attendees: [],
      joinPolicy: "open",
    });
    const unrelatedPersonalSchedule = await createMeetingScheduleForUser(db, organizer, {
      startsAt: "2026-07-16T11:00:00.000Z",
      durationMinutes: 30,
      timeZone: "Asia/Dhaka",
      attendees: [],
      joinPolicy: "open",
    });

    await expect(
      db.query.meetingLinks.findFirst({ where: { id: created.meetingLinkId } }),
    ).resolves.toMatchObject({
      reusePolicy: "reusable",
      spaceId: "spc_math_201",
      allowGuests: false,
      title: null,
      expiresAt: null,
    });
    await expect(
      db.query.meetingSchedules.findFirst({ where: { id: created.id } }),
    ).resolves.toMatchObject({
      organizerUserId: organizer.id,
      spaceId: "spc_math_201",
      title: "Math 201 Class meeting",
    });
    expect(
      await db.query.meetingScheduleAttendees.findMany({ where: { scheduleId: created.id } }),
    ).toHaveLength(12);
    expect(await db.select().from(userContacts)).toHaveLength(0);
    await expect(listSchedules(db, organizer)).resolves.toEqual([
      expect.objectContaining({ id: created.id, attendeeCount: 12, attendees: [] }),
      expect.objectContaining({ id: unrelatedPersonalSchedule.id, spaceId: null }),
    ]);
    await expect(
      listMeetingSchedulesPageForUser(db, organizer, {
        spaceId: "spc_math_201",
      }),
    ).resolves.toMatchObject({
      schedules: [expect.objectContaining({ id: created.id, spaceId: "spc_math_201" })],
      nextCursor: null,
    });
    await expect(
      resolveManageableMeetingScheduleForUser(
        db,
        organizer,
        { participant: "Student 5", timeZone: "Asia/Dhaka" },
        now,
      ),
    ).resolves.toMatchObject({
      id: created.id,
      attendeeCount: 12,
      attendees: [],
    });

    await expect(
      createMeetingScheduleForUser(
        db,
        {
          ...organizer,
          id: memberUsers[0].id,
          name: memberUsers[0].name,
          email: memberUsers[0].email,
          plan: "free",
        },
        {
          startsAt: "2026-07-16T10:30:00.000Z",
          durationMinutes: 30,
          timeZone: "UTC",
          spaceId: "spc_math_201",
          attendees: [],
          joinPolicy: "open",
        },
      ),
    ).rejects.toThrow(/space/i);

    const second = await createMeetingScheduleForUser(db, organizer, {
      startsAt: "2026-07-18T09:00:00.000Z",
      durationMinutes: 30,
      timeZone: "Asia/Dhaka",
      spaceId: "spc_math_201",
      attendees: [],
      joinPolicy: "open",
    });
    expect(second.meetingLinkId).toBe(created.meetingLinkId);

    const changedAt = new Date();
    changedAt.setMilliseconds(0);
    await rescheduleMeetingScheduleRecord(
      db,
      organizer.id,
      {
        scheduleId: created.id,
        expectedRevision: 1,
        startsAt: "2026-07-17T09:00:00.000Z",
        durationMinutes: 60,
        timeZone: "Asia/Dhaka",
      },
      changedAt,
    );
    await expect(
      db.query.meetingLinks.findFirst({ where: { id: created.meetingLinkId } }),
    ).resolves.toMatchObject({
      expiresAt: null,
      archivedAt: null,
    });

    const canceledAt = new Date(changedAt.getTime() + 60_000);
    await db.delete(spaceMembers).where(eq(spaceMembers.id, "spm_math_owner"));
    await expect(
      cancelMeetingScheduleRecord(
        db,
        organizer.id,
        { scheduleId: created.id, expectedRevision: 2 },
        canceledAt,
      ),
    ).rejects.toThrow(/scheduled meeting/i);
    await db.insert(spaceMembers).values({
      id: "spm_math_owner_restored",
      spaceId: "spc_math_201",
      userId: organizer.id,
      role: "admin",
      joinedAt: canceledAt,
    });
    await cancelMeetingScheduleRecord(
      db,
      organizer.id,
      { scheduleId: created.id, expectedRevision: 2 },
      canceledAt,
    );
    await expect(
      db.query.meetingLinks.findFirst({ where: { id: created.meetingLinkId } }),
    ).resolves.toMatchObject({
      archivedAt: null,
    });
  });

});
