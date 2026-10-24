import { check, foreignKey, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import {
  JOIN_POLICIES as JOIN_POLICY_VALUES,
  MEETING_SCHEDULE_NOTIFICATION_KINDS as MEETING_SCHEDULE_NOTIFICATION_KIND_VALUES,
  MEETING_SCHEDULE_NOTIFICATION_STATUSES as MEETING_SCHEDULE_NOTIFICATION_STATUS_VALUES,
} from "@orbmeet/domain-model";
import { oneOf, optionalTextLength, requiredTrimmedTextLength } from "./columns.ts";
import { users } from "./identity.ts";
import { spaces } from "./spaces.ts";
import { meetingLinks } from "./meeting-links.ts";
import { meetings } from "./meetings.ts";

// ============================================================================
// SCHEDULING
// ============================================================================

/**
 * A schedule is the advertised plan for one future meeting in a Space — an
 * intention, never a live Meeting. A shared-Space schedule advertises the
 * Space's default link; a personal schedule either advertises the organizer's
 * reusable personal link or mints a dedicated one-time link in their personal
 * Space (writer-enforced by the schedule creator).
 * `meetingId` records the occurrence that fulfilled the plan; purging that
 * meeting nulls the reference, the intention record survives.
 */

export const meetingSchedules = sqliteTable(
  "meeting_schedules",
  {
    id: text("id").notNull().primaryKey(),
    meetingLinkId: text("meeting_link_id")
      .notNull()
      .references(() => meetingLinks.id, { onDelete: "cascade" }),
    meetingId: text("meeting_id")
      .unique()
      .references(() => meetings.id, { onDelete: "set null" }),
    organizerUserId: text("organizer_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    spaceId: text("space_id")
      .notNull()
      .references(() => spaces.id, { onDelete: "cascade" }),
    title: text("title"),
    joinPolicy: text("join_policy", { enum: JOIN_POLICY_VALUES })
      .notNull()
      .default("open"),
    startsAt: integer("starts_at", { mode: "timestamp" }).notNull(),
    endsAt: integer("ends_at", { mode: "timestamp" }).notNull(),
    timeZone: text("time_zone").notNull(),
    reminderMinutesBefore: integer("reminder_minutes_before"),
    idempotencyKey: text("idempotency_key"),
    idempotencyFingerprint: text("idempotency_fingerprint"),
    revision: integer("revision").notNull().default(1),
    /**
     * Unique to the write that produced `revision`. Statements batched with a
     * reschedule or cancellation act only where it is theirs, so a request
     * that lost the race to another writes nothing beside it.
     */
    writeToken: text("write_token"),
    canceledAt: integer("canceled_at", { mode: "timestamp" }),
    canceledByUserId: text("canceled_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    cancelReason: text("cancel_reason"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date())
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("meeting_schedules_organizer_starts_idx").on(
      table.organizerUserId,
      table.startsAt,
    ),
    index("meeting_schedules_starts_canceled_idx").on(table.startsAt, table.canceledAt),
    index("meeting_schedules_space_starts_idx").on(table.spaceId, table.startsAt),
    index("meeting_schedules_link_starts_idx").on(table.meetingLinkId, table.startsAt),
    index("meeting_schedules_canceled_by_user_id_idx").on(table.canceledByUserId),
    uniqueIndex("meeting_schedules_organizer_idempotency_unique_idx").on(
      table.organizerUserId,
      table.idempotencyKey,
    ),
    check("meeting_schedules_title_length_check", optionalTextLength(table.title, 200)),
    check("meeting_schedules_join_policy_check", oneOf(table.joinPolicy, JOIN_POLICY_VALUES)),
    check("meeting_schedules_time_zone_length_check", requiredTrimmedTextLength(table.timeZone, 100)),
    check(
      "meeting_schedules_reminder_minutes_check",
      sql`${table.reminderMinutesBefore} IS NULL OR (${table.reminderMinutesBefore} >= 5 AND ${table.reminderMinutesBefore} <= 10080)`,
    ),
    check("meeting_schedules_idempotency_key_length_check", optionalTextLength(table.idempotencyKey, 128)),
    check(
      "meeting_schedules_idempotency_fingerprint_check",
      sql`${table.idempotencyFingerprint} IS NULL OR (
        ${table.idempotencyKey} IS NOT NULL
        AND length(${table.idempotencyFingerprint}) = 64
        AND ${table.idempotencyFingerprint} NOT GLOB '*[^0-9a-f]*'
      )`,
    ),
    check("meeting_schedules_revision_positive_check", sql`${table.revision} > 0`),
    check("meeting_schedules_ends_after_starts_check", sql`${table.endsAt} > ${table.startsAt}`),
    check("meeting_schedules_updated_after_created_check", sql`${table.updatedAt} >= ${table.createdAt}`),
    check(
      "meeting_schedules_cancel_shape_check",
      sql`(
        (${table.canceledAt} IS NULL AND ${table.canceledByUserId} IS NULL AND ${table.cancelReason} IS NULL)
        OR (${table.canceledAt} IS NOT NULL)
      )`,
    ),
    check("meeting_schedules_cancel_reason_length_check", optionalTextLength(table.cancelReason, 500)),
    // A schedule's advertised link always belongs to the schedule's space.
    foreignKey({
      columns: [table.meetingLinkId, table.spaceId],
      foreignColumns: [meetingLinks.id, meetingLinks.spaceId],
      name: "meeting_schedules_link_space_fk",
    }).onDelete("cascade"),
  ],
);

/**
 * Who a schedule invites, by normalized email. `userId` links an attendee who
 * has an account; it is nulled if that account is deleted, and the email
 * remains so notifications still reach the person.
 */
export const meetingScheduleAttendees = sqliteTable(
  "meeting_schedule_attendees",
  {
    id: text("id").notNull().primaryKey(),
    scheduleId: text("schedule_id")
      .notNull()
      .references(() => meetingSchedules.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    email: text("email").notNull(),
    normalizedEmail: text("normalized_email").notNull(),
    displayName: text("display_name"),
    invitedAt: integer("invited_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex("meeting_schedule_attendees_schedule_email_unique_idx").on(
      table.scheduleId,
      table.normalizedEmail,
    ),
    uniqueIndex("meeting_schedule_attendees_id_schedule_unique_idx").on(
      table.id,
      table.scheduleId,
    ),
    index("meeting_schedule_attendees_user_starts_idx").on(table.userId, table.scheduleId),
    index("meeting_schedule_attendees_normalized_email_idx").on(table.normalizedEmail),
    check("meeting_schedule_attendees_email_length_check", sql`length(${table.email}) <= 320`),
    check(
      "meeting_schedule_attendees_normalized_email_length_check",
      sql`length(${table.normalizedEmail}) <= 320`,
    ),
    check(
      "meeting_schedule_attendees_display_name_length_check",
      optionalTextLength(table.displayName, 100),
    ),
  ],
);

/**
 * The outbox of schedule emails: one row per attendee, schedule revision and
 * kind (invitation, reminder, rescheduled, canceled), retried with backoff and
 * delivered at most once.
 */
export const meetingScheduleNotifications = sqliteTable(
  "meeting_schedule_notifications",
  {
    id: text("id").notNull().primaryKey(),
    scheduleId: text("schedule_id")
      .notNull()
      .references(() => meetingSchedules.id, { onDelete: "cascade" }),
    attendeeId: text("attendee_id")
      .notNull()
      .references(() => meetingScheduleAttendees.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: MEETING_SCHEDULE_NOTIFICATION_KIND_VALUES }).notNull(),
    revision: integer("revision").notNull(),
    status: text("status", { enum: MEETING_SCHEDULE_NOTIFICATION_STATUS_VALUES })
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: integer("next_attempt_at", { mode: "timestamp" }).notNull(),
    // Set by the claim that hands the message to the provider; cleared only
    // when the provider refused it outright. While set, the row is never
    // claimed again: delivery is at most once (see notifications.server.ts).
    deliveryStartedAt: integer("delivery_started_at", { mode: "timestamp" }),
    sentAt: integer("sent_at", { mode: "timestamp" }),
    lastError: text("last_error"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex("meeting_schedule_notifications_delivery_unique_idx").on(
      table.scheduleId,
      table.attendeeId,
      table.revision,
      table.kind,
    ),
    foreignKey({
      columns: [table.attendeeId, table.scheduleId],
      foreignColumns: [meetingScheduleAttendees.id, meetingScheduleAttendees.scheduleId],
      name: "meeting_schedule_notifications_attendee_schedule_fk",
    }).onDelete("cascade"),
    index("meeting_schedule_notifications_due_idx").on(table.status, table.nextAttemptAt),
    index("meeting_schedule_notifications_schedule_idx").on(table.scheduleId),
    index("meeting_schedule_notifications_attendee_idx").on(table.attendeeId),
    check(
      "meeting_schedule_notifications_kind_check",
      oneOf(table.kind, MEETING_SCHEDULE_NOTIFICATION_KIND_VALUES),
    ),
    check(
      "meeting_schedule_notifications_status_check",
      oneOf(table.status, MEETING_SCHEDULE_NOTIFICATION_STATUS_VALUES),
    ),
    check("meeting_schedule_notifications_revision_positive_check", sql`${table.revision} > 0`),
    check("meeting_schedule_notifications_attempts_nonnegative_check", sql`${table.attempts} >= 0`),
    check(
      "meeting_schedule_notifications_sent_shape_check",
      sql`(
        (${table.status} IN ('pending', 'failed') AND ${table.sentAt} IS NULL)
        OR (${table.status} = 'sent' AND ${table.sentAt} IS NOT NULL)
      )`,
    ),
    check(
      "meeting_schedule_notifications_last_error_length_check",
      optionalTextLength(table.lastError, 1000),
    ),
  ],
);

export type MeetingSchedule = typeof meetingSchedules.$inferSelect;
export type MeetingScheduleAttendee = typeof meetingScheduleAttendees.$inferSelect;
export type MeetingScheduleNotification = typeof meetingScheduleNotifications.$inferSelect;
