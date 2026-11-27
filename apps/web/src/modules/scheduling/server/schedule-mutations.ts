import type { Database } from "@orbmeet/db";
import {
  meetingLinks,
  meetingScheduleAttendees,
  meetingScheduleNotifications,
  meetingSchedules,
  meetings,
} from "@orbmeet/db/schema";
import { and, eq, isNull, sql } from "drizzle-orm";
import { Errors } from "@/lib/app-errors";
import { getRunChanges, isUniqueConstraintError } from "@/platform/database/db-utils";
import {
  MINIMUM_SCHEDULING_LEAD_MS,
  SPACE_SCHEDULE_OVERLAP_MESSAGE,
  activeLinkForSchedule,
  assertCanManageSchedule,
  assertScheduleHasNotStarted,
  atomicScheduleAuthority,
  hasOverlappingLinkSchedule,
  hasOverlappingSpaceSchedule,
  noOccurrenceForSchedule,
  noOverlappingLinkSchedule,
  noOverlappingSpaceSchedule,
  pendingNotificationColumns,
  prepareReminderAt,
  prepareTiming,
  writtenBy,
  type CancelMeetingScheduleInput,
  type RescheduleMeetingInput,
} from "./schedule-guards";

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
