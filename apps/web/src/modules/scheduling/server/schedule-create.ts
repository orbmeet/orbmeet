import type { Database } from "@orbmeet/db";
import {
  meetingLinks,
  meetingScheduleAttendees,
  meetingScheduleNotifications,
  meetingSchedules,
  spaceMembers,
  spaces,
  users,
} from "@orbmeet/db/schema";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { Errors } from "@/lib/app-errors";
import { generateId } from "@/lib/ids";
import { logError } from "@/lib/logger";
import type { AuthenticatedUser } from "@/modules/identity/contract/auth/session-user";
import { generateMeetingCode } from "@/modules/meetings/contract/code-generation";
import { getSpaceAccess, retainsSpaceManagerSql } from "@/modules/spaces/server/helpers";
import { ensurePersonalSpace } from "@/modules/spaces/server/personal";
import { boundedStatements } from "@/platform/database/db-batching";
import { getRunChanges, isUniqueConstraintError } from "@/platform/database/db-utils";
import {
  SPACE_SCHEDULE_OVERLAP_MESSAGE,
  attendeeIdSql,
  hasOverlappingLinkSchedule,
  hasOverlappingSpaceSchedule,
  loadIdempotentMeetingScheduleCreate,
  meetingScheduleCreateFingerprint,
  noOverlappingLinkSchedule,
  noOverlappingSpaceSchedule,
  pendingNotificationColumns,
  prepareAttendees,
  prepareReminderAt,
  prepareTiming,
  type CreateMeetingScheduleInput,
} from "./schedule-guards";

const MAX_CODE_COLLISION_ATTEMPTS = 3;
const MAX_PERSONAL_ATTENDEES = 10;

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
      emailFromAccount: attendee.emailFromAccount,
      invitedAt: now,
    };
  });
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
  // Every row below belongs to the schedule its batch inserts first, and is
  // written only once that schedule exists: when the schedule's own guard
  // (an overlap, a link archived meanwhile, a role lost) writes nothing, they
  // write nothing too, and the refusal is reported as itself rather than as a
  // foreign key failing the batch. Notifications are selected from the
  // attendees the batch wrote, so they follow the same rule.
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const scheduleExists = sql`exists (select 1 from ${meetingSchedules} where ${meetingSchedules.id} = ${scheduleId})`;
  const attendeeInserts = attendeeRows.map((attendee) => db.insert(meetingScheduleAttendees).select(sql`
    select
      ${attendee.id}, ${scheduleId}, ${attendee.userId}, ${attendee.email}, ${attendee.normalizedEmail},
      ${attendee.displayName}, ${attendee.emailFromAccount ? 1 : 0}, ${nowSeconds}
    where ${scheduleExists}
  `));
  const notificationInserts = [
    db.insert(meetingScheduleNotifications).select(sql`
      select ${pendingNotificationColumns("invitation", 1, nowSeconds, nowSeconds)}
      from ${meetingScheduleAttendees} attendee
      where attendee.schedule_id = ${scheduleId}
    `),
    ...(reminderAt
      ? [db.insert(meetingScheduleNotifications).select(sql`
          select ${pendingNotificationColumns("reminder", 1, Math.floor(reminderAt.getTime() / 1000), nowSeconds)}
          from ${meetingScheduleAttendees} attendee
          where attendee.schedule_id = ${scheduleId}
        `)]
      : []),
  ];

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
        1,
        ${nowSeconds}
      from ${spaceMembers} member
      inner join ${users} member_user on member_user.id = member.user_id
      inner join ${spaces} current_space on current_space.id = member.space_id
      where member.space_id = ${input.spaceId}
        and member.user_id <> ${organizer.id}
        and current_space.archived_at is null
        and ${scheduleExists}
    `);
    try {
      const [insertResult, attendeeResult] = await db.batch([
        insertSchedule,
        insertSpaceAttendees,
        ...notificationInserts,
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
