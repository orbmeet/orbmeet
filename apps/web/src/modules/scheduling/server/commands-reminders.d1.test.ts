import { beforeEach, describe, expect, it } from "vitest";

import { meetingScheduleNotifications } from "@orbmeet/db/schema";

import {
  createMeetingScheduleRecord,
  rescheduleMeetingScheduleRecord,
} from "./commands";

import { type TestDb } from "@/test/db";

import { now, organizer, seedScheduleUsers } from "@/test/commands-test-support";

let db: TestDb;

beforeEach(async () => {
  db = await seedScheduleUsers();
});

describe("Scheduled meeting commands: reminders", () => {
  it("queues a reminder at the chosen lead time and moves it when rescheduled", async () => {
    const created = await createMeetingScheduleRecord(
      db,
      organizer,
      {
        title: "Reminder lesson",
        startsAt: "2026-07-16T09:00:00.000Z",
        durationMinutes: 45,
        timeZone: "Asia/Dhaka",
        attendees: [{ email: "maruf@example.com" }],
        joinPolicy: "open",
        reminderMinutesBefore: 60,
      },
      { now },
    );

    await expect(
      db.query.meetingSchedules.findFirst({ where: { id: created.id } }),
    ).resolves.toMatchObject({ reminderMinutesBefore: 60 });
    await expect(db.select().from(meetingScheduleNotifications)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "invitation", nextAttemptAt: now }),
        expect.objectContaining({
          kind: "reminder",
          revision: 1,
          nextAttemptAt: new Date("2026-07-16T08:00:00.000Z"),
        }),
      ]),
    );

    await rescheduleMeetingScheduleRecord(
      db,
      organizer.id,
      {
        scheduleId: created.id,
        expectedRevision: 1,
        startsAt: "2026-07-17T10:00:00.000Z",
        durationMinutes: 45,
        timeZone: "Asia/Dhaka",
      },
      new Date("2026-07-14T10:00:00.000Z"),
    );

    const reminders = (await db.select().from(meetingScheduleNotifications)).filter(
      (notification) => notification.kind === "reminder",
    );
    expect(reminders).toEqual([
      expect.objectContaining({ revision: 1, status: "failed" }),
      expect.objectContaining({
        revision: 2,
        status: "pending",
        nextAttemptAt: new Date("2026-07-17T09:00:00.000Z"),
      }),
    ]);
  });

  it("writes nothing beside the winner for a reschedule that lost the race", async () => {
    const created = await createMeetingScheduleRecord(
      db,
      organizer,
      {
        title: "Raced lesson",
        startsAt: "2026-07-16T09:00:00.000Z",
        durationMinutes: 45,
        timeZone: "Asia/Dhaka",
        attendees: [{ email: "maruf@example.com" }],
        joinPolicy: "open",
        reminderMinutesBefore: 60,
      },
      { now },
    );
    // Two edits of revision 1, to the same time, disagreeing about the reminder.
    const edit = (reminderMinutesBefore: number | null) => rescheduleMeetingScheduleRecord(
      db,
      organizer.id,
      {
        scheduleId: created.id,
        expectedRevision: 1,
        startsAt: "2026-07-17T10:00:00.000Z",
        durationMinutes: 45,
        timeZone: "Asia/Dhaka",
        reminderMinutesBefore,
      },
      new Date("2026-07-14T10:00:00.000Z"),
    );
    const results = await Promise.allSettled([edit(null), edit(60)]);
    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);

    const schedule = await db.query.meetingSchedules.findFirst({ where: { id: created.id } });
    const pendingReminders = (await db.select().from(meetingScheduleNotifications)).filter(
      (notification) => notification.kind === "reminder" && notification.status === "pending",
    );
    // Whatever the winner chose about reminders is all there is.
    expect(pendingReminders).toHaveLength(schedule?.reminderMinutesBefore === null ? 0 : 1);
    const rescheduled = (await db.select().from(meetingScheduleNotifications)).filter(
      (notification) => notification.kind === "rescheduled",
    );
    expect(rescheduled).toHaveLength(1);
  });

  it("retires an inherited reminder when a reschedule moves inside its delivery window", async () => {
    const created = await createMeetingScheduleRecord(
      db,
      organizer,
      {
        title: "Reminder lesson",
        startsAt: "2026-07-16T09:00:00.000Z",
        durationMinutes: 45,
        timeZone: "Asia/Dhaka",
        attendees: [],
        joinPolicy: "open",
        reminderMinutesBefore: 1440,
      },
      { now },
    );

    await expect(
      rescheduleMeetingScheduleRecord(
        db,
        organizer.id,
        {
          scheduleId: created.id,
          expectedRevision: 1,
          startsAt: "2026-07-14T12:00:00.000Z",
          durationMinutes: 45,
          timeZone: "Asia/Dhaka",
        },
        new Date("2026-07-14T10:00:00.000Z"),
      ),
    ).resolves.toMatchObject({
      reminderMinutesBefore: null,
    });
  });

});
