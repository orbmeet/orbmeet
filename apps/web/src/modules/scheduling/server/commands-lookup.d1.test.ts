import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  meetingLinks,
  meetingSchedules,
  meetings,
  spaceMembers,
  spaces,
} from "@orbmeet/db/schema";
import { eq } from "drizzle-orm";

import { SCHEDULED_MEETING_LATE_JOIN_MS } from "@/modules/meetings/contract/constants";

import { selectMeetingLookupByCode } from "@/modules/meetings/server/history/meeting-lookup.server";

import { createMeetingScheduleRecord } from "./commands";
import { createMeetingScheduleForUser } from "./creation";
import {
  listMeetingSchedulesPageForUser,
  resolveManageableMeetingScheduleForUser,
} from "@/modules/scheduling/server/queries.server";

import { type TestDb } from "@/test/db";

import {
  createFixture,
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

describe("Scheduled meeting commands: resolving and listing", () => {
  it("never finds a schedule by an attendee address the schedule hides", async () => {
    await createMeetingScheduleRecord(
      db,
      organizer,
      {
        title: "Private invite",
        startsAt: "2026-07-16T09:00:00.000Z",
        durationMinutes: 45,
        timeZone: "Asia/Dhaka",
        attendees: [{ email: "maruf@example.com", privateEmail: true, displayName: "Maruf" }],
        joinPolicy: "open",
      },
      { now },
    );
    const [schedule] = await listSchedules(db, organizer, now);
    expect(schedule.attendees).toEqual([expect.objectContaining({ displayName: "Maruf", email: "" })]);

    const find = (participant: string) =>
      resolveManageableMeetingScheduleForUser(
        db,
        organizer,
        { date: "2026-07-16", timeZone: "Asia/Dhaka", participant },
        now,
      );
    await expect(find("maruf@example.com")).rejects.toMatchObject({ code: "SCHEDULE_NOT_FOUND" });
    await expect(find("example.com")).rejects.toMatchObject({ code: "SCHEDULE_NOT_FOUND" });
    await expect(find("Maruf")).resolves.toMatchObject({ title: "Private invite" });
  });

  it("resolves a manageable schedule from remembered details without exposing IDs in ambiguity", async () => {
    const first = await createFixture(db);
    await createFixture(db, "2026-07-16T12:00:00.000Z", "Budget review");

    await expect(
      resolveManageableMeetingScheduleForUser(
        db,
        organizer,
        {
          date: "2026-07-16",
          timeZone: "Asia/Dhaka",
          title: "planning",
          participant: "Maruf",
        },
        now,
      ),
    ).resolves.toMatchObject({ id: first.id, revision: 1, title: "Planning with Maruf" });

    await expect(
      resolveManageableMeetingScheduleForUser(
        db,
        organizer,
        { date: "2026-07-16", timeZone: "Asia/Dhaka" },
        now,
      ),
    ).rejects.toMatchObject({
      code: "AMBIGUOUS_SCHEDULE",
      data: {
        candidates: [
          expect.not.objectContaining({ id: expect.anything() }),
          expect.not.objectContaining({ id: expect.anything() }),
        ],
      },
    });
  });

  it("applies human selectors before the bounded result window", async () => {
    let targetId = "";
    const base = Date.parse("2026-07-16T09:00:00.000Z");
    for (let index = 0; index < 51; index += 1) {
      const schedule = await createFixture(db, 
        new Date(base + index * 60_000).toISOString(),
        index === 50 ? "Needle planning" : `Routine planning ${index}`,
      );
      if (index === 50) targetId = schedule.id;
    }

    await expect(
      resolveManageableMeetingScheduleForUser(
        db,
        organizer,
        { title: "Needle", timeZone: "Asia/Dhaka" },
        now,
      ),
    ).resolves.toMatchObject({ id: targetId, title: "Needle planning" });
  });

  it("applies exact local-date bounds before the bounded result window", async () => {
    const target = await createFixture(db, "2026-07-16T09:00:00.000Z", "Local-date target");
    const distractorBase = Date.parse("2026-07-16T10:01:00.000Z");
    for (let index = 0; index < 51; index += 1) {
      await createFixture(db, 
        new Date(distractorBase + index * 60_000).toISOString(),
        `Next local day ${index}`,
      );
    }

    await expect(
      resolveManageableMeetingScheduleForUser(
        db,
        organizer,
        { date: "2026-07-16", timeZone: "Pacific/Kiritimati" },
        now,
      ),
    ).resolves.toMatchObject({ id: target.id, title: "Local-date target" });
  });


  it("marks a future room unavailable before its early join window", async () => {
    const realNow = new Date();
    const startsAt = new Date(realNow.getTime() + 60 * 60_000);
    startsAt.setMilliseconds(0);
    const created = await createMeetingScheduleRecord(
      db,
      organizer,
      {
        title: "Later",
        startsAt: startsAt.toISOString(),
        durationMinutes: 30,
        timeZone: "UTC",
        attendees: [],
        joinPolicy: "open",
      },
      { now: realNow },
    );

    await expect(selectMeetingLookupByCode(db, created.code, organizer.id)).resolves.toMatchObject({
      exists: true,
      canStartMeeting: false,
      scheduledNotOpenYet: true,
      scheduledStartsAt: startsAt.toISOString(),
    });
  });

  it("keeps a missed schedule visible throughout its late-start recovery window", async () => {
    const created = await createFixture(db);
    const queryNow = new Date();
    queryNow.setMilliseconds(0);
    await db
      .update(meetingSchedules)
      .set({
        startsAt: new Date(queryNow.getTime() - 2 * 60 * 60_000),
        endsAt: new Date(queryNow.getTime() - 60 * 60_000),
        updatedAt: queryNow,
      })
      .where(eq(meetingSchedules.id, created.id));
    await db
      .update(meetingLinks)
      .set({
        expiresAt: new Date(queryNow.getTime() + 60 * 60_000),
        updatedAt: queryNow,
      })
      .where(eq(meetingLinks.id, created.meetingLinkId));

    await expect(listSchedules(db, organizer)).resolves.toEqual([
      expect.objectContaining({ id: created.id, state: "late_start", canManage: true }),
    ]);
  });

  it("filters completed occurrences before applying the upcoming-page limit", async () => {
    const completed = await createFixture(db, "2026-07-16T09:00:00.000Z", "Already happened");
    const upcoming = await createFixture(db, "2026-07-17T09:00:00.000Z", "Still upcoming");
    const completedLink = await db.query.meetingLinks.findFirst({
      where: { id: completed.meetingLinkId },
      columns: { spaceId: true },
    });
    const startedAt = new Date("2026-07-16T09:00:00.000Z");
    const endedAt = new Date("2026-07-16T09:30:00.000Z");
    await db.insert(meetings).values({
      id: "mtg_completed_schedule_page",
      meetingLinkId: completed.meetingLinkId,
      title: "Already happened",
      startedByUserId: organizer.id,
      spaceId: completedLink!.spaceId,
      spaceKind: "personal",
      status: "ended",
      billingPrincipalType: "user",
      billingPrincipalId: organizer.id,
      billingPlan: "pro",
      allowGuests: true,
      recordingEnabled: true,
      joinPolicy: "approval_required",
      startedAt,
      endedAt,
      updatedAt: endedAt,
    });
    await db
      .update(meetingSchedules)
      .set({
        meetingId: "mtg_completed_schedule_page",
        updatedAt: endedAt,
      })
      .where(eq(meetingSchedules.id, completed.id));

    await expect(
      listMeetingSchedulesPageForUser(db, organizer, {
        now: new Date("2026-07-16T12:00:00.000Z"),
        limit: 1,
      }),
    ).resolves.toEqual({
      schedules: [expect.objectContaining({ id: upcoming.id, state: "upcoming" })],
      nextCursor: null,
    });
  });

  it("stops listing an unstarted Space schedule after its late-start window", async () => {
    pinClock();
    await db.insert(spaces).values({
      kind: "shared",
      id: "spc_expired_schedule",
      name: "Past Project",
      ownerUserId: organizer.id,
      slug: "past-project",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(spaceMembers).values([
      {
        id: "spm_expired_owner",
        spaceId: "spc_expired_schedule",
        userId: organizer.id,
        role: "admin",
        joinedAt: now,
      },
      {
        id: "spm_expired_member",
        spaceId: "spc_expired_schedule",
        userId: "usr_maruf",
        role: "member",
        joinedAt: now,
      },
    ]);
    const created = await createMeetingScheduleForUser(db, organizer, {
      startsAt: "2026-07-16T09:00:00.000Z",
      durationMinutes: 60,
      timeZone: "Asia/Dhaka",
      spaceId: "spc_expired_schedule",
      attendees: [],
      joinPolicy: "open",
    });
    const queryNow = new Date("2026-07-18T12:00:00.000Z");
    await db
      .update(meetingSchedules)
      .set({
        startsAt: new Date(queryNow.getTime() - SCHEDULED_MEETING_LATE_JOIN_MS - 2 * 60 * 60_000),
        endsAt: new Date(queryNow.getTime() - SCHEDULED_MEETING_LATE_JOIN_MS - 60 * 60_000),
        updatedAt: queryNow,
      })
      .where(eq(meetingSchedules.id, created.id));

    await expect(listSchedules(db, organizer, queryNow)).resolves.toEqual([]);
  });

});
