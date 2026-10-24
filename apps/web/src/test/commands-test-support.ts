// Shared construction for the scheduled meeting command tests.
import { vi } from "vitest";

import { meetingLinks, spaceMembers, spaces, users } from "@orbmeet/db/schema";

import type { AuthenticatedUser } from "@/modules/identity/contract/auth/session-user";

import { createTestDb, type TestDb } from "@/test/db";

import { listMeetingSchedulesPageForUser } from "@/modules/scheduling/server/queries.server";

import { createMeetingScheduleRecord } from "@/modules/scheduling/server/commands";

export const now = new Date("2026-07-14T09:00:00.000Z");

export const organizer: AuthenticatedUser = {
  id: "usr_schedule_host",
  name: "Schedule Host",
  email: "host@example.com",
  image: null,
  timeZone: "Asia/Dhaka",
  transcribeMeetings: true,
  appearance: "system",
  plan: "pro",
  role: "user",
  subscriptionStatus: "active",
  hasManagedSubscription: true,
};

/** A fresh database whose users are the organizer and Maruf. */
export async function seedScheduleUsers(): Promise<TestDb> {
  const db = await createTestDb();
  const createdAt = new Date("2026-07-14T08:00:00.000Z");
  await db.insert(users).values([
    {
      id: organizer.id,
      name: organizer.name,
      email: organizer.email,
      normalizedEmail: organizer.email,
      image: null,
      plan: organizer.plan,
      role: organizer.role,
      createdAt,
      updatedAt: createdAt,
    },
    {
      id: "usr_maruf",
      name: "Maruf",
      email: "Maruf@Example.com",
      normalizedEmail: "maruf@example.com",
      image: null,
      plan: "free",
      role: "user",
      createdAt,
      updatedAt: createdAt,
    },
  ]);
  return db;
}

// createMeetingScheduleForUser reads the real clock (no `now` injection), so
// tests exercising it must pin Date or their fixed startsAt values expire.
export function pinClock() {
  vi.useFakeTimers({ toFake: ["Date"], now });
}

export async function createFixture(
  db: TestDb,
  startsAt = "2026-07-16T09:00:00.000Z",
  title = "Planning with Maruf",
) {
  return createMeetingScheduleRecord(
    db,
    organizer,
    {
      title,
      startsAt,
      durationMinutes: 45,
      timeZone: "Asia/Dhaka",
      attendees: [
        { email: "maruf@example.com" },
        { email: "MARUF@example.com", displayName: "Duplicate" },
        { email: organizer.email },
      ],
      joinPolicy: "approval_required",
    },
    { now },
  );
}

export async function insertSpaceScheduleFixture(db: TestDb) {
  await db.insert(spaces).values({
    kind: "shared",
    id: "spc_no_overlap",
    name: "One meeting at a time",
    ownerUserId: organizer.id,
    slug: "one-meeting-at-a-time",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(spaceMembers).values({
    id: "spm_no_overlap_owner",
    spaceId: "spc_no_overlap",
    userId: organizer.id,
    role: "admin",
    joinedAt: now,
  });
  await db.insert(meetingLinks).values({
    id: "link_no_overlap",
    code: "abc-defg-hij",
    spaceId: "spc_no_overlap",
    spaceKind: "shared" as const,
    allowGuests: false,
    expiresAt: null,
    createdAt: now,
    updatedAt: now,
    reusePolicy: "reusable",
  });
  return { id: "link_no_overlap", code: "abc-defg-hij" };
}

/** Every schedule the viewer's list shows, as the paged listing serves it. */
export async function listSchedules(
  db: Parameters<typeof listMeetingSchedulesPageForUser>[0],
  user: { id: string; email: string },
  now?: Date,
) {
  return (await listMeetingSchedulesPageForUser(db, user, { now, limit: 100 })).schedules;
}
