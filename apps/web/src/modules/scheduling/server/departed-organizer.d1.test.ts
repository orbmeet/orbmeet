import { describe, expect, it, beforeEach } from "vitest";
import { createTestDb, type TestDb } from "@/test/db";
import { seedSharedSpace } from "@/test/fixtures";
import {
  users,
  meetingScheduleAttendees,
  meetingSchedules,
  meetingLinks,
  spaceMembers,
  userContacts,
} from "@orbmeet/db/schema";
import { eq } from "drizzle-orm";

import {
  cancelMeetingScheduleRecord,
  rescheduleMeetingScheduleRecord,
} from "@/modules/scheduling/server/commands";
import { resolveManageableMeetingScheduleForUser } from "@/modules/scheduling/server/queries.server";
import type { AutomationScheduleSelector } from "@orbmeet/public-api-contract";
import { getSpaceAccess } from "@/modules/spaces/server/helpers";

let db: TestDb;

beforeEach(async () => {
  db = await createTestDb();
});

async function seedUser(id: string) {
  const now = new Date();
  await db.insert(users).values({
    id,
    name: id,
    email: `${id}@example.com`,
    normalizedEmail: `${id}@example.com`,
    role: "user",
    createdAt: now,
    updatedAt: now,
  });
}

/** Admin A organized a shared Space's schedule, then left; admin B remains. */
async function seedDepartedOrganizerSchedule() {
  await seedUser("usr_admin_a");
  await seedUser("usr_admin_b");
  await seedUser("usr_owner");

  const spaceId = await seedSharedSpace(db, {
    id: "space_ds_probe",
    ownerUserId: "usr_owner",
    slug: "ds-probe",
    members: [
      { userId: "usr_owner", role: "owner" },
      { userId: "usr_admin_a", role: "admin" },
      { userId: "usr_admin_b", role: "admin" },
    ],
  });

  const now = new Date();
  await db.insert(meetingLinks).values({
    id: "link_ds_probe",
    code: "abc-defg-hij",
    reusePolicy: "reusable",
    spaceId,
    spaceKind: "shared",
    allowGuests: false,
    joinPolicy: "open",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(meetingSchedules).values({
    id: "sched_ds_probe",
    organizerUserId: "usr_admin_a",
    spaceId,
    meetingLinkId: "link_ds_probe",
    title: "Weekly standup",
    startsAt: new Date(now.getTime() + 86_400_000),
    endsAt: new Date(now.getTime() + 86_400_000 + 90 * 60_000),
    timeZone: "UTC",
    revision: 1,
    createdAt: now,
    updatedAt: now,
  });

  // The organizer departs the space.
  await db
    .delete(spaceMembers)
    .where(eq(spaceMembers.id, "space_ds_probe_usr_admin_a"));
  return { spaceId, now };
}

describe("departed organizer schedules", () => {
  it("lets a remaining admin reschedule and cancel", async () => {
    const { spaceId, now } = await seedDepartedOrganizerSchedule();

    // The read side advertises admin control: getSpaceAccess says admin B
    // holds canManage — exactly what assertCanManageSchedule requires, and
    // its organizerStillBelongs escape hatch (organizer no longer a member)
    // means the precheck intends to grant authority to admin B.
    const access = await getSpaceAccess(db, spaceId, "usr_admin_b");
    expect(access?.capabilities.canManage).toBe(true);

    await rescheduleMeetingScheduleRecord(db, "usr_admin_b", {
      scheduleId: "sched_ds_probe", expectedRevision: 1,
      startsAt: new Date(now.getTime() + 2 * 86_400_000).toISOString(),
      durationMinutes: 45, timeZone: "UTC",
    });
    await expect(cancelMeetingScheduleRecord(db, "usr_admin_a", {
      scheduleId: "sched_ds_probe", expectedRevision: 2,
    })).rejects.toThrow();
    await cancelMeetingScheduleRecord(db, "usr_admin_b", {
      scheduleId: "sched_ds_probe", expectedRevision: 2,
    });
    expect(await db.query.meetingSchedules.findFirst({ where: { id: "sched_ds_probe" } }))
      .toMatchObject({ revision: 3, canceledByUserId: "usr_admin_b", canceledAt: expect.any(Date) });
  });

  it("does not let a remaining admin search the schedule's invitees", async () => {
    const { now } = await seedDepartedOrganizerSchedule();
    await seedUser("usr_carol");
    // Admin A knows Carol's private address; admin B was never shown it, nor
    // any invitee of a shared Space's schedule.
    await db.insert(userContacts).values({
      id: "contact_carol",
      ownerUserId: "usr_admin_a",
      contactUserId: "usr_carol",
      email: "secret-carol@private.test",
      normalizedEmail: "secret-carol@private.test",
      displayName: "Carol",
      source: "invitation",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(meetingScheduleAttendees).values([
      {
        id: "attendee_carol",
        scheduleId: "sched_ds_probe",
        userId: "usr_carol",
        email: "secret-carol@private.test",
        normalizedEmail: "secret-carol@private.test",
        displayName: "Carol",
        invitedAt: now,
      },
      {
        id: "attendee_guest",
        scheduleId: "sched_ds_probe",
        email: "guest@outside.test",
        normalizedEmail: "guest@outside.test",
        displayName: "Guest",
        invitedAt: now,
      },
    ]);
    const adminB = { id: "usr_admin_b", email: "usr_admin_b@example.com" };
    const find = (selector: Omit<AutomationScheduleSelector, "timeZone">) =>
      resolveManageableMeetingScheduleForUser(db, adminB, { ...selector, timeZone: "UTC" }, now);

    await expect(find({ title: "standup" })).resolves.toMatchObject({ id: "sched_ds_probe", attendees: [] });
    for (const participant of ["secret-carol@private.test", "guest@outside.test", "Carol", "Guest"]) {
      await expect(find({ participant })).rejects.toMatchObject({ code: "SCHEDULE_NOT_FOUND" });
    }
  });
});
