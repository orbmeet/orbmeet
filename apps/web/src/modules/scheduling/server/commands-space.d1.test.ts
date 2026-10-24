import { beforeEach, describe, expect, it } from "vitest";

import {
  meetingScheduleAttendees,
  meetingScheduleNotifications,
  meetingSchedules,
  spaceMembers,
} from "@orbmeet/db/schema";
import { eq } from "drizzle-orm";

import {
  createMeetingScheduleRecord,
  rescheduleMeetingScheduleRecord,
} from "./commands";

import { type TestDb } from "@/test/db";

import {
  createFixture,
  insertSpaceScheduleFixture,
  now,
  organizer,
  seedScheduleUsers,
} from "@/test/commands-test-support";

let db: TestDb;

beforeEach(async () => {
  db = await seedScheduleUsers();
});

describe("Scheduled meeting commands: Space overlap and authority", () => {
  it("atomically rejects overlapping schedules for the same Space", async () => {
    const spaceMeetingLink = await insertSpaceScheduleFixture(db);
    const createSpaceSchedule = (startsAt: string, durationMinutes: number) =>
      createMeetingScheduleRecord(
        db,
        organizer,
        {
          title: "Space session",
          startsAt,
          durationMinutes,
          timeZone: "UTC",
          spaceId: "spc_no_overlap",
          attendees: [],
          joinPolicy: "open",
        },
        { now, spaceMeetingLink },
      );

    await createSpaceSchedule("2026-07-16T09:00:00.000Z", 60);
    await expect(createSpaceSchedule("2026-07-16T09:30:00.000Z", 30)).rejects.toThrow(
      /already has a scheduled meeting/i,
    );

    const adjacent = await createSpaceSchedule("2026-07-16T10:00:00.000Z", 30);
    await expect(
      rescheduleMeetingScheduleRecord(
        db,
        organizer.id,
        {
          scheduleId: adjacent.id,
          expectedRevision: 1,
          startsAt: "2026-07-16T09:45:00.000Z",
          durationMinutes: 30,
          timeZone: "UTC",
        },
        now,
      ),
    ).rejects.toThrow(/already has a scheduled meeting/i);
  });

  it("re-checks Space manager authority in the schedule insert", async () => {
    const link = await insertSpaceScheduleFixture(db);
    await db
      .update(spaceMembers)
      .set({ role: "member" })
      .where(eq(spaceMembers.userId, organizer.id));

    await expect(
      createMeetingScheduleRecord(
        db,
        organizer,
        {
          title: "Stale admin schedule",
          startsAt: "2026-07-16T11:00:00.000Z",
          durationMinutes: 30,
          timeZone: "Asia/Dhaka",
          spaceId: "spc_no_overlap",
          attendees: [{ email: "maruf@example.com" }],
          joinPolicy: "open",
        },
        { now, spaceMeetingLink: link, spaceName: "One meeting at a time" },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    await expect(db.select().from(meetingSchedules)).resolves.toEqual([]);
    await expect(db.select().from(meetingScheduleAttendees)).resolves.toEqual([]);
    await expect(db.select().from(meetingScheduleNotifications)).resolves.toEqual([]);
  });

  it("allows personal schedules to overlap when one is rescheduled", async () => {
    await createFixture(db, "2026-07-16T09:00:00.000Z", "First personal meeting");
    const second = await createFixture(db, "2026-07-16T11:00:00.000Z", "Second personal meeting");

    await expect(
      rescheduleMeetingScheduleRecord(
        db,
        organizer.id,
        {
          scheduleId: second.id,
          expectedRevision: 1,
          startsAt: "2026-07-16T09:15:00.000Z",
          durationMinutes: 30,
          timeZone: "UTC",
        },
        now,
      ),
    ).resolves.toMatchObject({ revision: 2 });
  });

});
