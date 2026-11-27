import type { Database } from "@orbmeet/db";
import {
  meetingLinks,
  meetingScheduleNotifications,
  meetingSchedules,
  meetings,
  spaceMembers,
  spaces,
} from "@orbmeet/db/schema";
import { and, eq, sql, type SQL } from "drizzle-orm";
import { AppError, Errors } from "@/lib/app-errors";
import { ID_PREFIX } from "@/lib/ids";
import { normalizeEmail } from "@/modules/identity/contract/auth/email-normalization";
import type { AuthenticatedUser } from "@/modules/identity/contract/auth/session-user";
import { SCHEDULED_MEETING_LATE_JOIN_MS } from "@/modules/meetings/contract/constants";
import { getSpaceAccess, retainsSpaceManagerSql, retainsSpaceViewerSql } from "@/modules/spaces/server/helpers";
import { canonicalSecondPrecisionInstant, requestFingerprint } from "@/platform/http/request-fingerprint";

// One row per attendee, so this id has to be generated in SQL — but with the
// same prefix the TypeScript writer uses. Two prefixes for one table meant no
// reader could key on either, and a bare `'msn_'` literal drifts from
// `ID_PREFIX` without anything failing.
const notificationIdSql = sql.raw(
  `'${ID_PREFIX.MEETING_SCHEDULE_NOTIFICATION}' || lower(hex(randomblob(16)))`,
);
export const attendeeIdSql = sql.raw(
  `'${ID_PREFIX.MEETING_SCHEDULE_ATTENDEE}' || lower(hex(randomblob(16)))`,
);

/**
 * A pending notification's columns, in the table's order, for an
 * `insert ... select` over `meeting_schedule_attendees attendee`.
 */
export function pendingNotificationColumns(
  kind: (typeof meetingScheduleNotifications.$inferInsert)["kind"],
  revision: number,
  nextAttemptAtSeconds: number,
  nowSeconds: number,
): SQL {
  return sql`${notificationIdSql}, attendee.schedule_id, attendee.id, ${kind}, ${revision}, 'pending', 0,
    ${nextAttemptAtSeconds}, null, null, null, ${nowSeconds}`;
}

export const MINIMUM_SCHEDULING_LEAD_MS = 60_000;
export const SPACE_SCHEDULE_OVERLAP_MESSAGE =
  "This Space already has a scheduled meeting during that time.";

export interface ScheduleAttendeeInput {
  email: string;
  privateEmail?: boolean;
  displayName?: string;
}

export interface CreateMeetingScheduleInput {
  title?: string;
  startsAt: string;
  durationMinutes: number;
  timeZone: string;
  spaceId?: string;
  /** An owned, active, reusable personal link. Omit to mint a one-time link. */
  meetingLinkId?: string;
  attendees: ScheduleAttendeeInput[];
  joinPolicy: "open" | "approval_required";
  reminderMinutesBefore?: number | null;
  idempotencyKey?: string;
  /** Canonical identity of the caller's request before mutable target resolution. */
  idempotencyFingerprint?: string;
}

export interface RescheduleMeetingInput {
  scheduleId: string;
  expectedRevision: number;
  startsAt: string;
  durationMinutes: number;
  timeZone: string;
  reminderMinutesBefore?: number | null;
}

export interface CancelMeetingScheduleInput {
  scheduleId: string;
  expectedRevision: number;
  reason?: string;
}

export interface PreparedTiming {
  startsAt: Date;
  endsAt: Date;
  linkExpiresAt: Date;
}

export async function meetingScheduleCreateFingerprint(
  input: Pick<
    CreateMeetingScheduleInput,
    | "title"
    | "startsAt"
    | "durationMinutes"
    | "timeZone"
    | "spaceId"
    | "meetingLinkId"
    | "attendees"
    | "joinPolicy"
    | "reminderMinutesBefore"
  >,
  selectorIdentity?: unknown,
): Promise<string> {
  const attendees = input.attendees
    .map((attendee) => ({
      email: normalizeEmail(attendee.email),
      displayName: attendee.displayName?.trim() || null,
    }))
    .sort(
      (left, right) =>
        left.email.localeCompare(right.email) ||
        (left.displayName ?? "").localeCompare(right.displayName ?? ""),
    );
  return requestFingerprint({
    title: input.title?.trim() || null,
    startsAt: canonicalSecondPrecisionInstant(input.startsAt),
    durationMinutes: input.durationMinutes,
    timeZone: input.timeZone,
    spaceId: input.spaceId ?? null,
    meetingLinkId: input.meetingLinkId ?? null,
    attendees,
    joinPolicy: input.joinPolicy,
    reminderMinutesBefore: input.reminderMinutesBefore ?? null,
    ...(selectorIdentity === undefined ? {} : { selectorIdentity }),
  });
}

export function prepareReminderAt(
  startsAt: Date,
  reminderMinutesBefore: number | null | undefined,
  now: Date,
): Date | null {
  if (reminderMinutesBefore == null) return null;
  const reminderAt = new Date(startsAt.getTime() - reminderMinutesBefore * 60_000);
  if (reminderAt.getTime() < now.getTime() + MINIMUM_SCHEDULING_LEAD_MS) {
    throw Errors.VALIDATION(
      "The reminder time must be at least one minute in the future. Choose a shorter reminder.",
    );
  }
  return reminderAt;
}

export function prepareTiming(startsAtInput: string, durationMinutes: number, now: Date): PreparedTiming {
  const startsAt = new Date(canonicalSecondPrecisionInstant(startsAtInput));
  const endsAt = new Date(startsAt.getTime() + durationMinutes * 60_000);
  if (!Number.isFinite(startsAt.getTime()) || !Number.isFinite(endsAt.getTime())) {
    throw Errors.VALIDATION("Invalid scheduled meeting time");
  }
  if (startsAt.getTime() < now.getTime() + MINIMUM_SCHEDULING_LEAD_MS) {
    throw Errors.VALIDATION("Scheduled meetings must start at least one minute in the future");
  }
  return {
    startsAt,
    endsAt,
    linkExpiresAt: new Date(endsAt.getTime() + SCHEDULED_MEETING_LATE_JOIN_MS),
  };
}

export function prepareAttendees(attendees: ScheduleAttendeeInput[], organizer: AuthenticatedUser) {
  const organizerEmail = normalizeEmail(organizer.email);
  const byEmail = new Map<string, ScheduleAttendeeInput & { normalizedEmail: string; emailFromAccount: boolean }>();
  for (const attendee of attendees) {
    const email = attendee.email.trim();
    const normalizedEmail = normalizeEmail(email);
    if (normalizedEmail === organizerEmail) continue;
    const existing = byEmail.get(normalizedEmail);
    if (existing) {
      // An address the organizer also gave is one they know.
      existing.emailFromAccount &&= attendee.privateEmail === true;
      continue;
    }
    byEmail.set(normalizedEmail, {
      email,
      normalizedEmail,
      displayName: attendee.displayName?.trim() || undefined,
      emailFromAccount: attendee.privateEmail === true,
    });
  }
  return [...byEmail.values()];
}

export async function assertScheduleHasNotStarted(
  db: Database,
  schedule: { meetingId: string | null; meetingLinkId: string; spaceId: string | null },
): Promise<void> {
  if (schedule.meetingId) {
    throw Errors.VALIDATION("A meeting that has already started cannot be rescheduled or canceled");
  }
  // A schedule advertising a one-time link owns it exclusively, so a link
  // occurrence is also a definitive start signal. Schedules on a shared
  // default link use meetingId alone.
  const link = await db.query.meetingLinks.findFirst({
    where: { id: schedule.meetingLinkId },
    columns: { reusePolicy: true },
  });
  if (link?.reusePolicy === "one_time") {
    const occurrence = await db.query.meetings.findFirst({
      where: { meetingLinkId: schedule.meetingLinkId },
      columns: { id: true },
    });
    if (occurrence) {
      throw Errors.VALIDATION(
        "A meeting that has already started cannot be rescheduled or canceled",
      );
    }
  }
}

export async function assertCanManageSchedule(
  db: Database,
  schedule: { organizerUserId: string; spaceId: string },
  userId: string,
): Promise<void> {
  const access = await getSpaceAccess(db, schedule.spaceId, userId);
  if (!access?.capabilities.canManage) throw Errors.NOT_FOUND("Scheduled meeting");
  if (schedule.organizerUserId === userId) return;
  const organizerStillBelongs = await db.query.spaceMembers.findFirst({
    where: {
      RAW: (row) =>
        and(eq(row.spaceId, schedule.spaceId), eq(row.userId, schedule.organizerUserId))!,
    },
    columns: { id: true },
  });
  if (organizerStillBelongs) throw Errors.NOT_FOUND("Scheduled meeting");
}

export function atomicScheduleAuthority(userId: string) {
  // The personal space keeps an owner membership row, so this one predicate
  // covers personal and shared schedules alike.
  return sql`${retainsSpaceManagerSql(meetingSchedules.spaceId, userId)}
    and (
      ${meetingSchedules.organizerUserId} = ${userId}
      or not exists (
        select 1 from ${spaceMembers} departed_organizer
        where departed_organizer.space_id = ${meetingSchedules.spaceId}
          and departed_organizer.user_id = ${meetingSchedules.organizerUserId}
      )
    )`;
}

/**
 * Whether the schedule's current state is the one this request wrote. A
 * reschedule or cancellation batches its dependent writes (the link, the
 * notifications) behind its own update; each acts only here, so a request
 * that lost the race to another writes nothing beside the winner's state.
 */
export function writtenBy(scheduleId: string, writeToken: string) {
  return sql`exists (
    select 1 from ${meetingSchedules}
    where ${meetingSchedules.id} = ${scheduleId}
      and ${meetingSchedules.writeToken} = ${writeToken}
  )`;
}

export function noOccurrenceForSchedule() {
  return sql`${meetingSchedules.meetingId} is null and (
    not exists (
      select 1 from ${meetingLinks}
      where ${meetingLinks.id} = ${meetingSchedules.meetingLinkId}
        and ${meetingLinks.reusePolicy} = 'one_time'
    )
    or not exists (
      select 1 from ${meetings}
      where ${meetings.meetingLinkId} = ${meetingSchedules.meetingLinkId}
    )
  )`;
}

export function activeLinkForSchedule() {
  return sql`exists (
    select 1 from ${meetingLinks}
    where ${meetingLinks.id} = ${meetingSchedules.meetingLinkId}
      and ${meetingLinks.archivedAt} is null
  )`;
}

export function noOverlappingSpaceSchedule(
  spaceId: string,
  startsAt: Date,
  endsAt: Date,
  excludeScheduleId?: string,
) {
  const startsAtSeconds = Math.floor(startsAt.getTime() / 1000);
  const endsAtSeconds = Math.floor(endsAt.getTime() / 1000);
  return sql`not exists (
    select 1 from ${meetingSchedules} existing
    where existing.space_id = ${spaceId}
      and existing.canceled_at is null
      ${excludeScheduleId ? sql`and existing.id <> ${excludeScheduleId}` : sql``}
      and existing.starts_at < ${endsAtSeconds}
      and existing.ends_at > ${startsAtSeconds}
  )`;
}

export function noOverlappingLinkSchedule(
  meetingLinkId: string,
  startsAt: Date,
  endsAt: Date,
  excludeScheduleId?: string,
) {
  const startsAtSeconds = Math.floor(startsAt.getTime() / 1000);
  const endsAtSeconds = Math.floor(endsAt.getTime() / 1000);
  return sql`not exists (
    select 1 from ${meetingSchedules} existing
    where existing.meeting_link_id = ${meetingLinkId}
      and existing.canceled_at is null
      ${excludeScheduleId ? sql`and existing.id <> ${excludeScheduleId}` : sql``}
      and existing.starts_at < ${endsAtSeconds}
      and existing.ends_at > ${startsAtSeconds}
  )`;
}

export async function hasOverlappingLinkSchedule(
  db: Database,
  meetingLinkId: string,
  startsAt: Date,
  endsAt: Date,
  excludeScheduleId?: string,
) {
  const overlap = await db.query.meetingSchedules.findFirst({
    where: {
      RAW: () =>
        sql`not ${noOverlappingLinkSchedule(meetingLinkId, startsAt, endsAt, excludeScheduleId)}`,
    },
    columns: { id: true },
  });
  return Boolean(overlap);
}

export async function hasOverlappingSpaceSchedule(
  db: Database,
  spaceId: string,
  startsAt: Date,
  endsAt: Date,
  excludeScheduleId?: string,
) {
  const overlap = await db.query.meetingSchedules.findFirst({
    where: {
      RAW: () =>
        sql`not ${noOverlappingSpaceSchedule(spaceId, startsAt, endsAt, excludeScheduleId)}`,
    },
    columns: { id: true },
  });
  return Boolean(overlap);
}

export async function loadIdempotentMeetingScheduleCreate(
  db: Database,
  organizerUserId: string,
  idempotencyKey?: string,
  expectedFingerprint?: string,
) {
  if (!idempotencyKey) return null;
  const row = await db
    .select({
      schedule: meetingSchedules,
      link: meetingLinks,
      spaceName: spaces.name,
      spaceKind: spaces.kind,
    })
    .from(meetingSchedules)
    .innerJoin(meetingLinks, eq(meetingLinks.id, meetingSchedules.meetingLinkId))
    .leftJoin(spaces, eq(spaces.id, meetingSchedules.spaceId))
    .where(
      and(
        eq(meetingSchedules.organizerUserId, organizerUserId),
        eq(meetingSchedules.idempotencyKey, idempotencyKey),
        // A replay answers with the schedule as it is now, its link's current
        // code among it, so it is only for an organizer who still belongs to
        // the live Space: one who left it, or whose Space was archived, is
        // answered as a new create would be, which refuses them.
        retainsSpaceViewerSql(meetingSchedules.spaceId, organizerUserId),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!row) return null;
  // Fingerprints are immutable create-request state. Schedule rows, titles,
  // attendees, contacts, and Space rosters can all legitimately change later
  // and therefore cannot be used to reconstruct this identity.
  if (
    expectedFingerprint &&
    row.schedule.idempotencyFingerprint &&
    row.schedule.idempotencyFingerprint !== expectedFingerprint
  ) {
    throw new AppError(
      "IDEMPOTENCY_KEY_REUSED",
      "Idempotency-Key was already used with a different request",
      422,
    );
  }
  const attendees = await db.query.meetingScheduleAttendees.findMany({
    where: { scheduleId: row.schedule.id },
    columns: { id: true },
  });
  return {
    id: row.schedule.id,
    meetingLinkId: row.schedule.meetingLinkId,
    code: row.link.code,
    revision: row.schedule.revision,
    title: row.schedule.title,
    startsAt: row.schedule.startsAt.toISOString(),
    endsAt: row.schedule.endsAt.toISOString(),
    timeZone: row.schedule.timeZone,
    reminderMinutesBefore: row.schedule.reminderMinutesBefore,
    // Replay matches on `(organizerUserId, idempotencyKey)` alone, and a
    // schedule can be canceled after it was created. Without this the retry of
    // a create that was since canceled answers 201 with a payload
    // indistinguishable from a fresh one — including a join `code` that now
    // 404s, because cancellation archived the link. Durable state, not derived
    // state: the replay stays byte-identical to the create until the schedule
    // itself actually changes.
    canceledAt: row.schedule.canceledAt?.toISOString() ?? null,
    attendeeCount: attendees.length,
    // The personal space is not addressable as a space in client payloads.
    spaceId: row.spaceKind === "shared" ? row.schedule.spaceId : null,
    spaceName: row.spaceKind === "shared" ? row.spaceName : null,
  };
}
