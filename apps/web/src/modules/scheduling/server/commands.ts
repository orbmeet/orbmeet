import type { Database } from "@orbmeet/db";
import {
  meetingLinks,
  meetingScheduleAttendees,
  meetingScheduleNotifications,
  meetingSchedules,
  meetings,
  spaceMembers,
  spaces,
  users,
} from "@orbmeet/db/schema";
import { and, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { AppError, Errors } from "@/lib/app-errors";
import { ID_PREFIX, generateId } from "@/lib/ids";

import { generateMeetingCode } from "@/modules/meetings/contract/code-generation";
import { normalizeEmail } from "@/modules/identity/contract/auth/email-normalization";
import { canonicalSecondPrecisionInstant, requestFingerprint } from "@/platform/http/request-fingerprint";
import { SCHEDULED_MEETING_LATE_JOIN_MS } from "@/modules/meetings/contract/constants";
import { boundedStatements } from "@/platform/database/db-batching";
import type { AuthenticatedUser } from "@/modules/identity/contract/auth/session-user";

import { getRunChanges, isUniqueConstraintError } from "@/platform/database/db-utils";
import { logError } from "@/lib/logger";
import { getSpaceAccess, retainsSpaceManagerSql } from "@/modules/spaces/server/helpers";
import { ensurePersonalSpace } from "@/modules/spaces/server/personal";

// One row per attendee, so this id has to be generated in SQL — but with the
// same prefix the TypeScript writer uses. Two prefixes for one table meant no
// reader could key on either, and a bare `'msn_'` literal drifts from
// `ID_PREFIX` without anything failing.
const notificationIdSql = sql.raw(
  `'${ID_PREFIX.MEETING_SCHEDULE_NOTIFICATION}' || lower(hex(randomblob(16)))`,
);
const attendeeIdSql = sql.raw(
  `'${ID_PREFIX.MEETING_SCHEDULE_ATTENDEE}' || lower(hex(randomblob(16)))`,
);

/**
 * A pending notification's columns, in the table's order, for an
 * `insert ... select` over `meeting_schedule_attendees attendee`.
 */
function pendingNotificationColumns(
  kind: (typeof meetingScheduleNotifications.$inferInsert)["kind"],
  revision: number,
  nextAttemptAtSeconds: number,
  nowSeconds: number,
): SQL {
  return sql`${notificationIdSql}, attendee.schedule_id, attendee.id, ${kind}, ${revision}, 'pending', 0,
    ${nextAttemptAtSeconds}, null, null, null, ${nowSeconds}`;
}

const MAX_CODE_COLLISION_ATTEMPTS = 3;
const MINIMUM_SCHEDULING_LEAD_MS = 60_000;
const MAX_PERSONAL_ATTENDEES = 10;

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

interface PreparedTiming {
  startsAt: Date;
  endsAt: Date;
  linkExpiresAt: Date;
}

function prepareReminderAt(
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

function prepareTiming(startsAtInput: string, durationMinutes: number, now: Date): PreparedTiming {
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

function prepareAttendees(attendees: ScheduleAttendeeInput[], organizer: AuthenticatedUser) {
  const organizerEmail = normalizeEmail(organizer.email);
  const byEmail = new Map<string, ScheduleAttendeeInput & { normalizedEmail: string }>();
  for (const attendee of attendees) {
    const email = attendee.email.trim();
    const normalizedEmail = normalizeEmail(email);
    if (normalizedEmail === organizerEmail) continue;
    if (!byEmail.has(normalizedEmail)) {
      byEmail.set(normalizedEmail, {
        email,
        normalizedEmail,
        displayName: attendee.displayName?.trim() || undefined,
      });
    }
  }
  return [...byEmail.values()];
}

async function assertScheduleHasNotStarted(
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

async function assertCanManageSchedule(
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

function atomicScheduleAuthority(userId: string) {
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
function writtenBy(scheduleId: string, writeToken: string) {
  return sql`exists (
    select 1 from ${meetingSchedules}
    where ${meetingSchedules.id} = ${scheduleId}
      and ${meetingSchedules.writeToken} = ${writeToken}
  )`;
}

function noOccurrenceForSchedule() {
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

function activeLinkForSchedule() {
  return sql`exists (
    select 1 from ${meetingLinks}
    where ${meetingLinks.id} = ${meetingSchedules.meetingLinkId}
      and ${meetingLinks.archivedAt} is null
  )`;
}

const SPACE_SCHEDULE_OVERLAP_MESSAGE =
  "This Space already has a scheduled meeting during that time.";

function noOverlappingSpaceSchedule(
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

function noOverlappingLinkSchedule(
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

async function hasOverlappingLinkSchedule(
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

async function hasOverlappingSpaceSchedule(
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

export async function createMeetingScheduleRecord(
  db: Database,
  organizer: AuthenticatedUser,
  input: CreateMeetingScheduleInput,
  options: {
    now?: Date;
    spaceMeetingLink?: { id: string; code: string };
    personalMeetingLink?: { id: string; code: string };
    spaceName?: string;
  },
) {
  const idempotencyFingerprint = input.idempotencyKey
    ? (input.idempotencyFingerprint ?? (await meetingScheduleCreateFingerprint(input)))
    : undefined;
  const attendees = prepareAttendees(input.attendees, organizer);
  const prior = await loadIdempotentMeetingScheduleCreate(
    db,
    organizer.id,
    input.idempotencyKey,
    idempotencyFingerprint,
  );
  if (prior) return prior;
  const now = options.now ?? new Date();
  const timing = prepareTiming(input.startsAt, input.durationMinutes, now);
  const reminderAt = prepareReminderAt(timing.startsAt, input.reminderMinutesBefore, now);
  if (!input.spaceId && attendees.length > MAX_PERSONAL_ATTENDEES) {
    throw Errors.VALIDATION(
      `A Meeting can notify at most ${MAX_PERSONAL_ATTENDEES} people by email`,
    );
  }
  const normalizedEmails = attendees.map((attendee) => attendee.normalizedEmail);
  const registeredUsers: { id: string; name: string; normalizedEmail: string }[] = [];
  for (const lookup of boundedStatements(normalizedEmails, (emails) =>
    db
      .select({ id: users.id, name: users.name, normalizedEmail: users.normalizedEmail })
      .from(users)
      .where(inArray(users.normalizedEmail, emails)))) {
    registeredUsers.push(...await lookup);
  }
  const registeredByEmail = new Map(registeredUsers.map((user) => [user.normalizedEmail, user]));

  const scheduleId = generateId("MEETING_SCHEDULE");
  const title = input.title?.trim() || null;
  const attendeeRows = attendees.map((attendee) => {
    const registered = registeredByEmail.get(attendee.normalizedEmail);
    return {
      id: generateId("MEETING_SCHEDULE_ATTENDEE"),
      scheduleId,
      userId: registered?.id ?? null,
      email: attendee.email,
      normalizedEmail: attendee.normalizedEmail,
      displayName: attendee.displayName ?? registered?.name ?? null,
      invitedAt: now,
    };
  });
  const notificationRows = attendeeRows.flatMap((attendee) => [
    {
      id: generateId("MEETING_SCHEDULE_NOTIFICATION"),
      scheduleId,
      attendeeId: attendee.id,
      kind: "invitation" as const,
      revision: 1,
      status: "pending" as const,
      attempts: 0,
      nextAttemptAt: now,
      sentAt: null,
      lastError: null,
      createdAt: now,
    },
    ...(reminderAt
      ? [
          {
            id: generateId("MEETING_SCHEDULE_NOTIFICATION"),
            scheduleId,
            attendeeId: attendee.id,
            kind: "reminder" as const,
            revision: 1,
            status: "pending" as const,
            attempts: 0,
            nextAttemptAt: reminderAt,
            sentAt: null,
            lastError: null,
            createdAt: now,
          },
        ]
      : []),
  ]);
  const scheduleValues = (meetingLinkId: string, spaceId: string) => ({
    id: scheduleId,
    meetingLinkId,
    meetingId: null,
    organizerUserId: organizer.id,
    spaceId,
    title,
    joinPolicy: input.joinPolicy,
    startsAt: timing.startsAt,
    endsAt: timing.endsAt,
    timeZone: input.timeZone,
    reminderMinutesBefore: input.reminderMinutesBefore ?? null,
    idempotencyKey: input.idempotencyKey ?? null,
    idempotencyFingerprint: idempotencyFingerprint ?? null,
    revision: 1,
    canceledAt: null,
    canceledByUserId: null,
    cancelReason: null,
    createdAt: now,
    updatedAt: now,
  });
  const attendeeInserts = boundedStatements(attendeeRows, (rows) =>
    db.insert(meetingScheduleAttendees).values(rows));
  const notificationInserts = boundedStatements(notificationRows, (rows) =>
    db.insert(meetingScheduleNotifications).values(rows));

  const serializeCreated = (
    meetingLinkId: string,
    code: string,
    attendeeCount = attendeeRows.length,
  ) => ({
    id: scheduleId,
    meetingLinkId,
    code,
    revision: 1,
    title,
    startsAt: timing.startsAt.toISOString(),
    endsAt: timing.endsAt.toISOString(),
    timeZone: input.timeZone,
    reminderMinutesBefore: input.reminderMinutesBefore ?? null,
    canceledAt: null,
    attendeeCount,
    spaceId: input.spaceId ?? null,
    spaceName: options.spaceName ?? null,
  });

  if (input.spaceId) {
    const spaceMeetingLink = options.spaceMeetingLink;
    if (!spaceMeetingLink) {
      throw Errors.VALIDATION("The Space meeting link is unavailable");
    }
    const startsAtSeconds = Math.floor(timing.startsAt.getTime() / 1000);
    const endsAtSeconds = Math.floor(timing.endsAt.getTime() / 1000);
    const nowSeconds = Math.floor(now.getTime() / 1000);
    // Gated INSERT ... SELECT makes the overlap gate part of the same SQLite
    // write transaction, so concurrent creators cannot both pass it. The
    // query-builder select maps columns by name.
    const insertSchedule = db.insert(meetingSchedules).select(
      db
        .select({
          id: sql`${scheduleId}`.as("id"),
          meetingLinkId: sql`${spaceMeetingLink.id}`.as("meeting_link_id"),
          meetingId: sql`null`.as("meeting_id"),
          organizerUserId: sql`${organizer.id}`.as("organizer_user_id"),
          spaceId: sql`${input.spaceId}`.as("space_id"),
          title: sql`${title}`.as("title"),
          joinPolicy: sql`${input.joinPolicy}`.as("join_policy"),
          startsAt: sql`${startsAtSeconds}`.as("starts_at"),
          endsAt: sql`${endsAtSeconds}`.as("ends_at"),
          timeZone: sql`${input.timeZone}`.as("time_zone"),
          reminderMinutesBefore: sql`${input.reminderMinutesBefore ?? null}`.as(
            "reminder_minutes_before",
          ),
          idempotencyKey: sql`${input.idempotencyKey ?? null}`.as("idempotency_key"),
          idempotencyFingerprint: sql`${idempotencyFingerprint ?? null}`.as(
            "idempotency_fingerprint",
          ),
          revision: sql`1`.as("revision"),
          canceledAt: sql`null`.as("canceled_at"),
          canceledByUserId: sql`null`.as("canceled_by_user_id"),
          cancelReason: sql`null`.as("cancel_reason"),
          createdAt: sql`${nowSeconds}`.as("created_at"),
          updatedAt: sql`${nowSeconds}`.as("updated_at"),
        })
        .from(sql`(select 1)`)
        .where(
          and(
            noOverlappingSpaceSchedule(input.spaceId, timing.startsAt, timing.endsAt),
            retainsSpaceManagerSql(input.spaceId, organizer.id),
          ),
        ),
    );
    // The caller resolves a human-readable roster before reaching this layer,
    // but membership may change in that window. Derive the durable attendee
    // set from the current Space membership inside the same atomic batch as
    // schedule creation. A departure ordered before this batch is excluded; a
    // departure ordered after it sees the schedule and its normal purge removes
    // the attendee. The organizer is deliberately not emailed.
    const insertSpaceAttendees = db.insert(meetingScheduleAttendees).select(sql`
      select
        ${attendeeIdSql},
        ${scheduleId},
        member.user_id,
        member_user.email,
        member_user.normalized_email,
        member_user.name,
        ${nowSeconds}
      from ${spaceMembers} member
      inner join ${users} member_user on member_user.id = member.user_id
      inner join ${spaces} current_space on current_space.id = member.space_id
      where member.space_id = ${input.spaceId}
        and member.user_id <> ${organizer.id}
        and current_space.archived_at is null
    `);
    const insertSpaceInvitations = db.insert(meetingScheduleNotifications).select(sql`
      select
        ${pendingNotificationColumns("invitation", 1, nowSeconds, nowSeconds)}
      from ${meetingScheduleAttendees} attendee
      where attendee.schedule_id = ${scheduleId}
    `);
    const insertSpaceReminders = reminderAt
      ? db.insert(meetingScheduleNotifications).select(sql`
        select
          ${pendingNotificationColumns("reminder", 1, Math.floor(reminderAt.getTime() / 1000), nowSeconds)}
        from ${meetingScheduleAttendees} attendee
        where attendee.schedule_id = ${scheduleId}
      `)
      : null;
    try {
      const [insertResult, attendeeResult] = await db.batch([
        insertSchedule,
        insertSpaceAttendees,
        insertSpaceInvitations,
        ...(insertSpaceReminders ? [insertSpaceReminders] : []),
      ]);
      if (getRunChanges(insertResult) === 0) {
        const access = await getSpaceAccess(db, input.spaceId, organizer.id);
        if (!access?.capabilities.canManage) {
          throw Errors.FORBIDDEN("Your Space role changed before the schedule was created.");
        }
        throw Errors.CONFLICT(SPACE_SCHEDULE_OVERLAP_MESSAGE);
      }
      return serializeCreated(
        spaceMeetingLink.id,
        spaceMeetingLink.code,
        getRunChanges(attendeeResult),
      );
    } catch (error) {
      const existing = await loadIdempotentMeetingScheduleCreate(
        db,
        organizer.id,
        input.idempotencyKey,
        idempotencyFingerprint,
      );
      if (existing) return existing;
      const access = await getSpaceAccess(db, input.spaceId, organizer.id);
      if (!access?.capabilities.canManage) {
        throw Errors.FORBIDDEN("Your Space role changed before the schedule was created.");
      }
      if (await hasOverlappingSpaceSchedule(db, input.spaceId, timing.startsAt, timing.endsAt)) {
        throw Errors.CONFLICT(SPACE_SCHEDULE_OVERLAP_MESSAGE);
      }
      logError("[scheduling] Failed to create Space meeting schedule", { scheduleId }, error);
      throw error;
    }
  }

  if (input.meetingLinkId) {
    const personalMeetingLink = options.personalMeetingLink;
    if (!personalMeetingLink || personalMeetingLink.id !== input.meetingLinkId) {
      throw Errors.NOT_FOUND("Personal meeting link");
    }
    const startsAtSeconds = Math.floor(timing.startsAt.getTime() / 1000);
    const endsAtSeconds = Math.floor(timing.endsAt.getTime() / 1000);
    const nowSeconds = Math.floor(now.getTime() / 1000);
    const insertSchedule = db.insert(meetingSchedules).select(
      db
        .select({
          id: sql`${scheduleId}`.as("id"),
          meetingLinkId: sql`${personalMeetingLink.id}`.as("meeting_link_id"),
          meetingId: sql`null`.as("meeting_id"),
          organizerUserId: sql`${organizer.id}`.as("organizer_user_id"),
          spaceId: meetingLinks.spaceId,
          title: sql`${title}`.as("title"),
          joinPolicy: sql`${input.joinPolicy}`.as("join_policy"),
          startsAt: sql`${startsAtSeconds}`.as("starts_at"),
          endsAt: sql`${endsAtSeconds}`.as("ends_at"),
          timeZone: sql`${input.timeZone}`.as("time_zone"),
          reminderMinutesBefore: sql`${input.reminderMinutesBefore ?? null}`.as(
            "reminder_minutes_before",
          ),
          idempotencyKey: sql`${input.idempotencyKey ?? null}`.as("idempotency_key"),
          idempotencyFingerprint: sql`${idempotencyFingerprint ?? null}`.as(
            "idempotency_fingerprint",
          ),
          revision: sql`1`.as("revision"),
          canceledAt: sql`null`.as("canceled_at"),
          canceledByUserId: sql`null`.as("canceled_by_user_id"),
          cancelReason: sql`null`.as("cancel_reason"),
          createdAt: sql`${nowSeconds}`.as("created_at"),
          updatedAt: sql`${nowSeconds}`.as("updated_at"),
        })
        .from(meetingLinks)
        .innerJoin(spaces, eq(spaces.id, meetingLinks.spaceId))
        .where(
          and(
            eq(meetingLinks.id, personalMeetingLink.id),
            eq(meetingLinks.reusePolicy, "reusable"),
            eq(meetingLinks.spaceKind, "personal"),
            isNull(meetingLinks.archivedAt),
            eq(spaces.ownerUserId, organizer.id),
            isNull(spaces.archivedAt),
            noOverlappingLinkSchedule(personalMeetingLink.id, timing.startsAt, timing.endsAt),
          ),
        ),
    );

    try {
      const [insertResult] = await db.batch([
        insertSchedule,
        ...attendeeInserts,
        ...notificationInserts,
      ]);
      if (getRunChanges(insertResult) === 0) {
        if (
          await hasOverlappingLinkSchedule(
            db,
            personalMeetingLink.id,
            timing.startsAt,
            timing.endsAt,
          )
        ) {
          throw Errors.CONFLICT("This meeting link is already scheduled during that time.");
        }
        throw Errors.NOT_FOUND("Personal meeting link");
      }
      return serializeCreated(personalMeetingLink.id, personalMeetingLink.code);
    } catch (error) {
      const existing = await loadIdempotentMeetingScheduleCreate(
        db,
        organizer.id,
        input.idempotencyKey,
        idempotencyFingerprint,
      );
      if (existing) return existing;
      if (
        await hasOverlappingLinkSchedule(db, personalMeetingLink.id, timing.startsAt, timing.endsAt)
      ) {
        throw Errors.CONFLICT("This meeting link is already scheduled during that time.");
      }
      throw error;
    }
  }

  // A personal schedule mints its dedicated one-time link in the organizer's
  // personal space. Ensure on this write path so interrupted provisioning
  // heals here.
  const personalSpaceId = await ensurePersonalSpace(db, organizer, now);

  let meetingLinkId = "";
  let code = "";

  for (let attempt = 0; attempt < MAX_CODE_COLLISION_ATTEMPTS; attempt++) {
    meetingLinkId = generateId("MEETING_LINK");
    code = generateMeetingCode();
    const insertLink = db.insert(meetingLinks).values({
      id: meetingLinkId,
      code,
      reusePolicy: "one_time",
      spaceId: personalSpaceId,
      spaceKind: "personal",
      spentAt: null,
      title,
      allowGuests: true,
      joinPolicy: input.joinPolicy,
      lastUsedAt: null,
      expiresAt: timing.linkExpiresAt,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    const insertSchedule = db
      .insert(meetingSchedules)
      .values(scheduleValues(meetingLinkId, personalSpaceId));

    try {
      await db.batch([insertLink, insertSchedule, ...attendeeInserts, ...notificationInserts]);
      return serializeCreated(meetingLinkId, code);
    } catch (error) {
      const existing = await loadIdempotentMeetingScheduleCreate(
        db,
        organizer.id,
        input.idempotencyKey,
        idempotencyFingerprint,
      );
      if (existing) return existing;
      if (!isUniqueConstraintError(error) || attempt === MAX_CODE_COLLISION_ATTEMPTS - 1) {
        logError("[scheduling] Failed to create meeting schedule", { scheduleId, attempt }, error);
        throw error;
      }
    }
  }

  throw Errors.CONFLICT("Could not allocate a meeting code. Please try again.");
}

export async function rescheduleMeetingScheduleRecord(
  db: Database,
  organizerUserId: string,
  input: RescheduleMeetingInput,
  now = new Date(),
) {
  const timing = prepareTiming(input.startsAt, input.durationMinutes, now);
  const schedule = await db.query.meetingSchedules.findFirst({
    where: { id: input.scheduleId },
  });
  if (!schedule) {
    throw Errors.NOT_FOUND("Scheduled meeting");
  }
  await assertCanManageSchedule(db, schedule, organizerUserId);
  if (schedule.canceledAt) throw Errors.VALIDATION("Canceled meetings cannot be rescheduled");
  if (schedule.revision !== input.expectedRevision) {
    throw Errors.CONFLICT("This meeting changed. Refresh it and try again.");
  }
  await assertScheduleHasNotStarted(db, schedule);
  let reminderMinutesBefore =
    input.reminderMinutesBefore === undefined
      ? schedule.reminderMinutesBefore
      : input.reminderMinutesBefore;
  let reminderAt: Date | null;
  if (input.reminderMinutesBefore === undefined && reminderMinutesBefore !== null) {
    const inheritedReminderAt = new Date(
      timing.startsAt.getTime() - reminderMinutesBefore * 60_000,
    );
    if (inheritedReminderAt.getTime() < now.getTime() + MINIMUM_SCHEDULING_LEAD_MS) {
      // The caller changed the meeting time, not the reminder policy. A reminder
      // whose delivery window has already passed is obsolete state, so retire it
      // instead of rejecting an otherwise valid reschedule for an omitted field.
      reminderMinutesBefore = null;
      reminderAt = null;
    } else {
      reminderAt = inheritedReminderAt;
    }
  } else {
    reminderAt = prepareReminderAt(timing.startsAt, reminderMinutesBefore, now);
  }
  const scheduleSpace = schedule.spaceId
    ? await db.query.spaces.findFirst({
        where: { id: schedule.spaceId },
        columns: { kind: true },
      })
    : null;
  const requiresOverlapGate = scheduleSpace?.kind === "shared";
  const scheduleLink = await db.query.meetingLinks.findFirst({
    where: { id: schedule.meetingLinkId },
    columns: { reusePolicy: true },
  });
  const requiresLinkOverlapGate =
    scheduleSpace?.kind === "personal" && scheduleLink?.reusePolicy === "reusable";

  const nextRevision = schedule.revision + 1;
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const writeToken = crypto.randomUUID();

  const updateSchedule = db
    .update(meetingSchedules)
    .set({
      startsAt: timing.startsAt,
      endsAt: timing.endsAt,
      timeZone: input.timeZone,
      reminderMinutesBefore,
      revision: nextRevision,
      writeToken,
      updatedAt: now,
    })
    .where(
      and(
        eq(meetingSchedules.id, schedule.id),
        eq(meetingSchedules.revision, input.expectedRevision),
        isNull(meetingSchedules.canceledAt),
        atomicScheduleAuthority(organizerUserId),
        activeLinkForSchedule(),
        noOccurrenceForSchedule(),
        requiresOverlapGate && schedule.spaceId
          ? noOverlappingSpaceSchedule(
              schedule.spaceId,
              timing.startsAt,
              timing.endsAt,
              schedule.id,
            )
          : sql`1 = 1`,
        requiresLinkOverlapGate
          ? noOverlappingLinkSchedule(
              schedule.meetingLinkId,
              timing.startsAt,
              timing.endsAt,
              schedule.id,
            )
          : sql`1 = 1`,
      ),
    );
  const updateLink = db
    .update(meetingLinks)
    .set({ expiresAt: timing.linkExpiresAt, updatedAt: now })
    .where(
      and(
        eq(meetingLinks.id, schedule.meetingLinkId),
        // Only a one-time link belongs exclusively to this schedule; a shared
        // default link must never be expired or archived by schedule changes.
        eq(meetingLinks.reusePolicy, "one_time"),
        isNull(meetingLinks.archivedAt),
        writtenBy(schedule.id, writeToken),
      ),
    );
  const insertNotifications = db
    .insert(meetingScheduleNotifications)
    .select(sql`
    select
      ${pendingNotificationColumns("rescheduled", nextRevision, nowSeconds, nowSeconds)}
    from ${meetingScheduleAttendees} attendee
    where attendee.schedule_id = ${schedule.id}
      and ${writtenBy(schedule.id, writeToken)}
      and exists (
        select 1 from ${meetingSchedules}
        where ${meetingSchedules.id} = ${schedule.id}
          and ${meetingSchedules.meetingId} is null
          and (
            not exists (
              select 1 from ${meetingLinks}
              where ${meetingLinks.id} = ${schedule.meetingLinkId}
                and ${meetingLinks.reusePolicy} = 'one_time'
            )
            or not exists (
              select 1 from ${meetings}
              where ${meetings.meetingLinkId} = ${schedule.meetingLinkId}
            )
          )
      )
  `)
    .onConflictDoNothing();
  const insertReminderNotifications = reminderAt
    ? db
        .insert(meetingScheduleNotifications)
        .select(sql`
      select
        ${pendingNotificationColumns("reminder", nextRevision, Math.floor(reminderAt.getTime() / 1000), nowSeconds)}
      from ${meetingScheduleAttendees} attendee
      where attendee.schedule_id = ${schedule.id}
        and ${writtenBy(schedule.id, writeToken)}
    `)
        .onConflictDoNothing()
    : null;
  const supersedePendingNotifications = db
    .update(meetingScheduleNotifications)
    .set({ status: "failed", lastError: "Superseded by a newer revision" })
    .where(
      and(
        eq(meetingScheduleNotifications.scheduleId, schedule.id),
        eq(meetingScheduleNotifications.status, "pending"),
        sql`${meetingScheduleNotifications.revision} < ${nextRevision}`,
        writtenBy(schedule.id, writeToken),
      ),
    );

  try {
    const [result] = await db.batch([
      updateSchedule,
      updateLink,
      supersedePendingNotifications,
      insertNotifications,
      ...(insertReminderNotifications ? [insertReminderNotifications] : []),
    ]);
    if (getRunChanges(result) === 0) {
      if (
        requiresOverlapGate &&
        schedule.spaceId &&
        (await hasOverlappingSpaceSchedule(
          db,
          schedule.spaceId,
          timing.startsAt,
          timing.endsAt,
          schedule.id,
        ))
      ) {
        throw Errors.CONFLICT(SPACE_SCHEDULE_OVERLAP_MESSAGE);
      }
      if (
        requiresLinkOverlapGate &&
        (await hasOverlappingLinkSchedule(
          db,
          schedule.meetingLinkId,
          timing.startsAt,
          timing.endsAt,
          schedule.id,
        ))
      ) {
        throw Errors.CONFLICT("This meeting link is already scheduled during that time.");
      }
      throw Errors.CONFLICT("This meeting changed. Refresh it and try again.");
    }
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw Errors.CONFLICT("This meeting changed. Refresh it and try again.");
    }
    throw error;
  }

  return {
    id: schedule.id,
    revision: nextRevision,
    startsAt: timing.startsAt.toISOString(),
    endsAt: timing.endsAt.toISOString(),
    timeZone: input.timeZone,
    reminderMinutesBefore,
  };
}

export async function cancelMeetingScheduleRecord(
  db: Database,
  organizerUserId: string,
  input: CancelMeetingScheduleInput,
  now = new Date(),
) {
  const schedule = await db.query.meetingSchedules.findFirst({
    where: { id: input.scheduleId },
  });
  if (!schedule) {
    throw Errors.NOT_FOUND("Scheduled meeting");
  }
  await assertCanManageSchedule(db, schedule, organizerUserId);
  if (schedule.canceledAt) {
    return { id: schedule.id, revision: schedule.revision, alreadyCanceled: true };
  }
  if (schedule.revision !== input.expectedRevision) {
    throw Errors.CONFLICT("This meeting changed. Refresh it and try again.");
  }
  await assertScheduleHasNotStarted(db, schedule);

  const nextRevision = schedule.revision + 1;
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const writeToken = crypto.randomUUID();

  const cancelSchedule = db
    .update(meetingSchedules)
    .set({
      canceledAt: now,
      canceledByUserId: organizerUserId,
      cancelReason: input.reason?.trim() || null,
      revision: nextRevision,
      writeToken,
      updatedAt: now,
    })
    .where(
      and(
        eq(meetingSchedules.id, schedule.id),
        eq(meetingSchedules.revision, input.expectedRevision),
        isNull(meetingSchedules.canceledAt),
        atomicScheduleAuthority(organizerUserId),
        activeLinkForSchedule(),
        noOccurrenceForSchedule(),
      ),
    );
  const archiveLink = db
    .update(meetingLinks)
    .set({ archivedAt: now, updatedAt: now })
    .where(
      and(
        eq(meetingLinks.id, schedule.meetingLinkId),
        // Only a one-time link belongs exclusively to this schedule; a shared
        // default link must never be expired or archived by schedule changes.
        eq(meetingLinks.reusePolicy, "one_time"),
        isNull(meetingLinks.archivedAt),
        writtenBy(schedule.id, writeToken),
      ),
    );
  const insertNotifications = db
    .insert(meetingScheduleNotifications)
    .select(sql`
    select
      ${pendingNotificationColumns("canceled", nextRevision, nowSeconds, nowSeconds)}
    from ${meetingScheduleAttendees} attendee
    where attendee.schedule_id = ${schedule.id}
      and ${writtenBy(schedule.id, writeToken)}
      and exists (
        select 1 from ${meetingSchedules}
        where ${meetingSchedules.id} = ${schedule.id}
          and ${meetingSchedules.meetingId} is null
          and (
            not exists (
              select 1 from ${meetingLinks}
              where ${meetingLinks.id} = ${schedule.meetingLinkId}
                and ${meetingLinks.reusePolicy} = 'one_time'
            )
            or not exists (
              select 1 from ${meetings}
              where ${meetings.meetingLinkId} = ${schedule.meetingLinkId}
            )
          )
      )
  `)
    .onConflictDoNothing();
  const supersedePendingNotifications = db
    .update(meetingScheduleNotifications)
    .set({ status: "failed", lastError: "Superseded by cancellation" })
    .where(
      and(
        eq(meetingScheduleNotifications.scheduleId, schedule.id),
        eq(meetingScheduleNotifications.status, "pending"),
        sql`${meetingScheduleNotifications.revision} < ${nextRevision}`,
        writtenBy(schedule.id, writeToken),
      ),
    );

  try {
    const [result] = await db.batch([
      cancelSchedule,
      archiveLink,
      supersedePendingNotifications,
      insertNotifications,
    ]);
    if (getRunChanges(result) === 0) {
      throw Errors.CONFLICT("This meeting changed. Refresh it and try again.");
    }
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw Errors.CONFLICT("This meeting changed. Refresh it and try again.");
    }
    throw error;
  }

  return { id: schedule.id, revision: nextRevision, alreadyCanceled: false };
}
