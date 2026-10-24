import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  meetingScheduleNotifications,
  meetingSchedules,
  spaceMembers,
  spaces,
} from "@orbmeet/db/schema";
import { eq } from "drizzle-orm";

import { ID_PREFIX } from "@/lib/ids";

import {
  cancelMeetingScheduleRecord,
  createMeetingScheduleRecord,
  meetingScheduleCreateFingerprint,
  rescheduleMeetingScheduleRecord,
} from "./commands";
import { createMeetingScheduleForUser } from "./creation";

import { type TestDb } from "@/test/db";

import {
  createFixture,
  insertSpaceScheduleFixture,
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

describe("Scheduled meeting commands: idempotency and revisions", () => {
  it("reschedules with revision concurrency and updates the link lifetime", async () => {
    const created = await createFixture(db);
    const changedAt = new Date("2026-07-14T10:00:00.000Z");
    const result = await rescheduleMeetingScheduleRecord(
      db,
      organizer.id,
      {
        scheduleId: created.id,
        expectedRevision: 1,
        startsAt: "2026-07-17T10:00:00.000Z",
        durationMinutes: 60,
        timeZone: "Asia/Dhaka",
      },
      changedAt,
    );

    expect(result.revision).toBe(2);
    await expect(
      db.query.meetingLinks.findFirst({ where: { id: created.meetingLinkId } }),
    ).resolves.toMatchObject({
      expiresAt: new Date("2026-07-18T11:00:00.000Z"),
    });
    await expect(
      rescheduleMeetingScheduleRecord(
        db,
        organizer.id,
        {
          scheduleId: created.id,
          expectedRevision: 1,
          startsAt: "2026-07-18T10:00:00.000Z",
          durationMinutes: 60,
          timeZone: "Asia/Dhaka",
        },
        changedAt,
      ),
    ).rejects.toThrow(/changed/i);
    const notifications = await db.select().from(meetingScheduleNotifications);
    // One prefix for the table, whichever writer produced the row: the
    // reschedule path generates ids in SQL because it writes one per attendee.
    expect(
      notifications.every((item) => item.id.startsWith(ID_PREFIX.MEETING_SCHEDULE_NOTIFICATION)),
    ).toBe(true);
    expect(new Set(notifications.map((item) => item.id)).size).toBe(notifications.length);
    expect(notifications.map((item) => [item.kind, item.revision])).toEqual([
      ["invitation", 1],
      ["rescheduled", 2],
    ]);
  });

  it("marks the idempotent replay of a canceled schedule as canceled", async () => {
    // Replay keys on `(organizerUserId, idempotencyKey)` only. A retry-queue
    // redelivery arriving after the organizer canceled must not answer with a
    // payload that reads as a live, joinable schedule.
    const input = {
      title: "Canceled then retried",
      startsAt: "2026-07-16T09:00:00.000Z",
      durationMinutes: 30,
      timeZone: "UTC",
      attendees: [{ email: "maruf@example.com" }],
      joinPolicy: "open" as const,
      idempotencyKey: "agent-request-canceled",
    };
    const created = await createMeetingScheduleRecord(db, organizer, input, { now });
    expect(created.canceledAt).toBeNull();

    await cancelMeetingScheduleRecord(
      db,
      organizer.id,
      { scheduleId: created.id, expectedRevision: created.revision },
      now,
    );

    const replayed = await createMeetingScheduleRecord(db, organizer, input, {
      now: new Date(now.getTime() + 60_000),
    });
    expect(replayed.id).toBe(created.id);
    expect(replayed.canceledAt).not.toBeNull();
  });

  it("uses one idempotency key to return one schedule and one invitation", async () => {
    const input = {
      title: "Idempotent planning",
      startsAt: "2026-07-16T09:00:00.000Z",
      durationMinutes: 30,
      timeZone: "UTC",
      attendees: [{ email: "maruf@example.com" }],
      joinPolicy: "open" as const,
      idempotencyKey: "agent-request-1",
    };
    const first = await createMeetingScheduleRecord(db, organizer, input, {
      now,
    });
    const retried = await createMeetingScheduleRecord(db, organizer, input, {
      now: new Date(now.getTime() + 60_000),
    });

    expect(retried).toEqual(first);
    expect(await db.select().from(meetingSchedules)).toHaveLength(1);
    expect(await db.select().from(meetingScheduleNotifications)).toHaveLength(1);
    await expect(
      db.query.meetingSchedules.findFirst({
        where: { id: first.id },
        columns: { idempotencyFingerprint: true },
      }),
    ).resolves.toMatchObject({
      idempotencyFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    await expect(
      db
        .update(meetingSchedules)
        .set({ idempotencyFingerprint: "not-a-sha256" })
        .where(eq(meetingSchedules.id, first.id)),
    ).rejects.toThrow();
    await expect(
      db.query.meetingSchedules.findFirst({
        where: { id: first.id },
        columns: { idempotencyFingerprint: true },
      }),
    ).resolves.toMatchObject({
      idempotencyFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it("returns the same idempotent response for fractional-second input", async () => {
    const input = {
      title: "Fractional planning",
      startsAt: "2026-07-16T09:00:00.500Z",
      durationMinutes: 30,
      timeZone: "UTC",
      attendees: [{ email: "maruf@example.com" }],
      joinPolicy: "open" as const,
      idempotencyKey: "agent-request-fractional",
    };

    const first = await createMeetingScheduleRecord(db, organizer, input, { now });
    const retried = await createMeetingScheduleRecord(db, organizer, input, { now });

    expect(first.startsAt).toBe("2026-07-16T09:00:00.000Z");
    expect(retried).toEqual(first);
  });

  it("canonicalizes attendee-set ordering in create fingerprints", async () => {
    const base = {
      title: "Order independent",
      startsAt: "2026-09-01T09:00:00Z",
      durationMinutes: 30,
      timeZone: "UTC",
      joinPolicy: "open" as const,
    };
    await expect(
      meetingScheduleCreateFingerprint({
        ...base,
        attendees: [
          { email: "B@example.com", displayName: "B" },
          { email: "a@example.com", displayName: "A" },
        ],
      }),
    ).resolves.toBe(
      await meetingScheduleCreateFingerprint({
        ...base,
        attendees: [
          { email: "a@example.com", displayName: "A" },
          { email: "b@example.com", displayName: "B" },
        ],
      }),
    );
  });

  it("rejects an idempotency key reused with a different schedule", async () => {
    const input = {
      title: "Original planning",
      startsAt: "2026-07-16T09:00:00.000Z",
      durationMinutes: 30,
      timeZone: "UTC",
      attendees: [{ email: "maruf@example.com" }],
      joinPolicy: "open" as const,
      idempotencyKey: "agent-request-mismatch",
    };
    await createMeetingScheduleRecord(db, organizer, input, { now });

    const retry = createMeetingScheduleRecord(
      db,
      organizer,
      {
        ...input,
        title: "Different planning",
      },
      { now },
    );

    await expect(retry).rejects.toMatchObject({
      code: "IDEMPOTENCY_KEY_REUSED",
      statusCode: 422,
    });
  });

  it("keeps the original request identity after the schedule is revised", async () => {
    const input = {
      title: "Original planning",
      startsAt: "2026-07-16T09:00:00.000Z",
      durationMinutes: 30,
      timeZone: "UTC",
      attendees: [{ email: "maruf@example.com" }],
      joinPolicy: "open" as const,
      idempotencyKey: "agent-request-revised",
    };
    const created = await createMeetingScheduleRecord(db, organizer, input, { now });
    await rescheduleMeetingScheduleRecord(
      db,
      organizer.id,
      {
        scheduleId: created.id,
        expectedRevision: 1,
        startsAt: "2026-07-17T09:00:00.000Z",
        durationMinutes: 45,
        timeZone: "Asia/Dhaka",
      },
      now,
    );

    await expect(createMeetingScheduleRecord(db, organizer, input, { now })).resolves.toMatchObject(
      { id: created.id, revision: 2 },
    );
    await expect(
      createMeetingScheduleRecord(
        db,
        organizer,
        {
          ...input,
          title: "A different request",
        },
        { now },
      ),
    ).rejects.toMatchObject({
      code: "IDEMPOTENCY_KEY_REUSED",
      statusCode: 422,
    });
  });

  it("does not derive idempotency from a mutable Space name or roster", async () => {
    pinClock();
    await insertSpaceScheduleFixture(db);
    const input = {
      startsAt: "2026-07-16T09:00:00.000Z",
      durationMinutes: 30,
      timeZone: "UTC",
      spaceId: "spc_no_overlap",
      attendees: [],
      joinPolicy: "open" as const,
      idempotencyKey: "agent-request-space-roster",
    };
    const first = await createMeetingScheduleForUser(db, organizer, input);

    await db
      .update(spaces)
      .set({ name: "Renamed after scheduling", updatedAt: now })
      .where(eq(spaces.id, "spc_no_overlap"));
    await db.insert(spaceMembers).values({
      id: "spm_no_overlap_new_member",
      spaceId: "spc_no_overlap",
      userId: "usr_maruf",
      role: "member",
      joinedAt: now,
    });
    await db
      .update(spaceMembers)
      .set({ role: "member" })
      .where(eq(spaceMembers.id, "spm_no_overlap_owner"));

    await expect(createMeetingScheduleForUser(db, organizer, input)).resolves.toMatchObject({
      id: first.id,
      attendeeCount: first.attendeeCount,
    });
    await expect(db.select().from(meetingSchedules)).resolves.toHaveLength(1);
  });


  it("commits only the winning mutation and its notification", async () => {
    const created = await createFixture(db);
    const mutationTime = new Date("2026-07-14T10:00:00.000Z");
    const results = await Promise.allSettled([
      rescheduleMeetingScheduleRecord(
        db,
        organizer.id,
        {
          scheduleId: created.id,
          expectedRevision: 1,
          startsAt: "2026-07-17T10:00:00.000Z",
          durationMinutes: 60,
          timeZone: "UTC",
        },
        mutationTime,
      ),
      cancelMeetingScheduleRecord(
        db,
        organizer.id,
        {
          scheduleId: created.id,
          expectedRevision: 1,
        },
        mutationTime,
      ),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const current = await db.query.meetingSchedules.findFirst({ where: { id: created.id } });
    const revisionTwo = (await db.select().from(meetingScheduleNotifications)).filter(
      (item) => item.revision === 2,
    );
    expect(revisionTwo).toHaveLength(1);
    expect(revisionTwo[0]?.kind).toBe(current?.canceledAt ? "canceled" : "rescheduled");
  });

});
