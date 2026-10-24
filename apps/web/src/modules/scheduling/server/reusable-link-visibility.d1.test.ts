// Schedules pinned to REUSABLE personal links have no link expiry at all
// (meetings/server/lifecycle/create.server.ts sets expiresAt = null for reusable
// links), so upcoming/selector queries must fall back to the occurrence's own
// late-start window instead of requiring link expiry — otherwise the schedule
// is invisible from creation until its occurrence goes open.
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { meetingLinks, meetingSchedules, meetings, users } from "@orbmeet/db/schema";

import { createTestDb, type TestDb } from "@/test/db";
import { personalSpaceIdFor, seedPersonalSpace } from "@/test/fixtures";
import { SCHEDULED_MEETING_LATE_JOIN_MS } from "@/modules/meetings/contract/constants";
import {
  findMeetingScheduleForUser,
  listMeetingSchedulesPageForUser,
  resolveManageableMeetingScheduleForUser,
} from "@/modules/scheduling/server/queries.server";

/** Every schedule the viewer's list shows, as the paged listing serves it. */
async function listSchedules(
  db: Parameters<typeof listMeetingSchedulesPageForUser>[0],
  user: { id: string; email: string },
  now?: Date,
) {
  return (await listMeetingSchedulesPageForUser(db, user, { now, limit: 100 })).schedules;
}

let db: TestDb;
const OWNER = "usr_link_owner";
const OWNER_EMAIL = `${OWNER}@example.com`;
const NOW = new Date("2026-09-16T12:00:00.000Z");
const STARTS_AT = new Date(NOW.getTime() + 24 * 60 * 60 * 1000);
const ENDS_AT = new Date(STARTS_AT.getTime() + 30 * 60 * 1000);
// Shared and one-time visibility both end one late-join window after endsAt.
const WINDOW_CLOSE = ENDS_AT.getTime() + SCHEDULED_MEETING_LATE_JOIN_MS;
const justInsideWindow = () => new Date(WINDOW_CLOSE - 60 * 1000);
const justPastWindow = () => new Date(WINDOW_CLOSE + 60 * 1000);

beforeEach(async () => {
  db = await createTestDb();
});

async function seedOwner() {
  await db.insert(users).values({
    id: OWNER,
    name: OWNER,
    email: OWNER_EMAIL,
    normalizedEmail: OWNER_EMAIL,
    image: null,
    plan: "free",
    role: "user",
    createdAt: NOW,
    updatedAt: NOW,
  });
  await seedPersonalSpace(db, OWNER, { now: NOW });
  return personalSpaceIdFor(OWNER);
}

async function seedLinkSchedule(options: {
  linkId: string;
  code: string;
  reusePolicy: "reusable" | "one_time";
  scheduleId: string;
  title: string;
  expiresAt?: Date | null;
  archivedAt?: Date | null;
}) {
  const spaceId = personalSpaceIdFor(OWNER);
  await db.insert(meetingLinks).values({
    id: options.linkId,
    code: options.code,
    spaceId,
    spaceKind: "personal",
    reusePolicy: options.reusePolicy,
    title: "Personal room",
    allowGuests: true,
    joinPolicy: "open",
    lastUsedAt: null,
    // Reusable links carry no expiry; one-time links expire like production
    // sets them (commands.ts: endsAt plus the late-join window).
    expiresAt:
      options.expiresAt ?? (options.reusePolicy === "one_time" ? new Date(WINDOW_CLOSE) : null),
    // Created before NOW so an `archivedAt` anchored to NOW passes the
    // archived-after-created CHECK constraint.
    createdAt: new Date(NOW.getTime() - 60 * 60 * 1000),
    updatedAt: new Date(NOW.getTime() - 60 * 60 * 1000),
    archivedAt: options.archivedAt ?? null,
  });
  await db.insert(meetingSchedules).values({
    id: options.scheduleId,
    meetingLinkId: options.linkId,
    meetingId: null,
    organizerUserId: OWNER,
    spaceId,
    title: options.title,
    joinPolicy: "open",
    startsAt: STARTS_AT,
    endsAt: ENDS_AT,
    timeZone: "UTC",
  });
}

// Mirrors the occurrence rows the meetings module writes when a schedule goes
// live (see commands-occurrence.d1.test.ts for the minimal column set).
async function seedOpenOccurrence(meetingId: string) {
  await db.insert(meetings).values({
    id: meetingId,
    meetingLinkId: "link_reusable",
    title: "Reusable sched",
    startedByUserId: OWNER,
    spaceId: personalSpaceIdFor(OWNER),
    spaceKind: "personal" as const,
    status: "open",
    billingPrincipalType: "user" as const,
    billingPrincipalId: OWNER,
    billingPlan: "free",
    allowGuests: true,
    recordingEnabled: false,
    joinPolicy: "open",
    startedAt: STARTS_AT,
    updatedAt: STARTS_AT,
  });
}

const viewer = { id: OWNER, email: OWNER_EMAIL };

describe("personal schedules on reusable links", () => {
  it("appears in list, page, and selector queries before the occurrence starts", async () => {
    await seedOwner();
    await seedLinkSchedule({
      linkId: "link_reusable",
      code: "abc-defg-hij",
      reusePolicy: "reusable",
      scheduleId: "sched_reusable",
      title: "Reusable sched",
    });

    const upcoming = await listSchedules(db, viewer, NOW);
    expect(upcoming.map((schedule) => schedule.id)).toContain("sched_reusable");

    const page = await listMeetingSchedulesPageForUser(db, viewer, { now: NOW });
    expect(page.schedules.map((schedule) => schedule.id)).toContain("sched_reusable");

    await expect(
      resolveManageableMeetingScheduleForUser(
        db,
        viewer,
        { timeZone: "UTC", title: "Reusable sched" },
        NOW,
      ),
    ).resolves.toMatchObject({ id: "sched_reusable", state: "upcoming" });

    // Direct lookup never applied the `now` filter; it kept working even while
    // the lists hid the schedule, and still does.
    await expect(findMeetingScheduleForUser(db, viewer, "sched_reusable")).resolves.toMatchObject({
      id: "sched_reusable",
    });
  });

  it("stays visible after the start while inside the late-start window", async () => {
    await seedOwner();
    await seedLinkSchedule({
      linkId: "link_reusable",
      code: "abc-defg-hij",
      reusePolicy: "reusable",
      scheduleId: "sched_reusable",
      title: "Reusable sched",
    });

    const upcoming = await listSchedules(db, viewer, justInsideWindow());
    expect(upcoming.map((schedule) => schedule.id)).toContain("sched_reusable");
    // Same "late_start" state shared-space schedules report in this window.
    expect(upcoming.find((schedule) => schedule.id === "sched_reusable")?.state).toBe("late_start");
  });

  it("disappears once the late-start window closes and no occurrence is open", async () => {
    await seedOwner();
    await seedLinkSchedule({
      linkId: "link_reusable",
      code: "abc-defg-hij",
      reusePolicy: "reusable",
      scheduleId: "sched_reusable",
      title: "Reusable sched",
    });

    const upcoming = await listSchedules(db, viewer, justPastWindow());
    expect(upcoming.map((schedule) => schedule.id)).not.toContain("sched_reusable");

    const page = await listMeetingSchedulesPageForUser(db, viewer, { now: justPastWindow() });
    expect(page.schedules.map((schedule) => schedule.id)).not.toContain("sched_reusable");

    await expect(
      resolveManageableMeetingScheduleForUser(
        db,
        viewer,
        { timeZone: "UTC", title: "Reusable sched" },
        justPastWindow(),
      ),
    ).rejects.toMatchObject({ code: "SCHEDULE_NOT_FOUND", statusCode: 404 });
  });

  it("an open occurrence keeps the schedule visible past the window", async () => {
    await seedOwner();
    await seedLinkSchedule({
      linkId: "link_reusable",
      code: "abc-defg-hij",
      reusePolicy: "reusable",
      scheduleId: "sched_reusable",
      title: "Reusable sched",
    });
    await seedOpenOccurrence("mtg_reusable");
    await db
      .update(meetingSchedules)
      .set({ meetingId: "mtg_reusable" })
      .where(eq(meetingSchedules.id, "sched_reusable"));

    const upcoming = await listSchedules(
      db,
      viewer,
      new Date(WINDOW_CLOSE + 60 * 60 * 1000),
    );
    expect(upcoming.find((schedule) => schedule.id === "sched_reusable")?.state).toBe("open");
  });

  it("one-time personal links behave exactly as before", async () => {
    await seedOwner();
    // Production one-time links expire at endsAt plus the late-join window.
    await seedLinkSchedule({
      linkId: "link_one_time",
      code: "klm-nopq-rst",
      reusePolicy: "one_time",
      scheduleId: "sched_one_time",
      title: "One time sched",
      expiresAt: new Date(WINDOW_CLOSE),
    });

    const upcoming = await listSchedules(db, viewer, NOW);
    expect(upcoming.map((schedule) => schedule.id)).toContain("sched_one_time");

    const afterExpiry = await listSchedules(db, viewer, justPastWindow());
    expect(afterExpiry.map((schedule) => schedule.id)).not.toContain("sched_one_time");
  });

  it("an archived link hides the schedule in every now-filtered path", async () => {
    await seedOwner();
    await seedLinkSchedule({
      linkId: "link_reusable",
      code: "abc-defg-hij",
      reusePolicy: "reusable",
      scheduleId: "sched_reusable",
      title: "Reusable sched",
      archivedAt: new Date(NOW.getTime() - 60 * 1000),
    });

    const upcoming = await listSchedules(db, viewer, NOW);
    expect(upcoming.map((schedule) => schedule.id)).not.toContain("sched_reusable");

    const page = await listMeetingSchedulesPageForUser(db, viewer, { now: NOW });
    expect(page.schedules.map((schedule) => schedule.id)).not.toContain("sched_reusable");

    await expect(
      resolveManageableMeetingScheduleForUser(
        db,
        viewer,
        { timeZone: "UTC", title: "Reusable sched" },
        NOW,
      ),
    ).rejects.toMatchObject({ code: "SCHEDULE_NOT_FOUND" });
  });
});
