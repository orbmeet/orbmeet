import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { meetings } from "./meetings.ts";
import { users } from "./identity.ts";

/** A turning point in a Meeting, as Orb saw it, with how far in it happened. */
export interface MeetingMoment {
  /** Seconds from the Meeting's start. */
  atSeconds: number;
  /** A few words: what happened. */
  title: string;
  /** One sentence of what was said or decided. */
  detail: string;
}

// ============================================================================
// MEETING SUMMARIES (AI-generated post-meeting summaries)
// ============================================================================

/**
 * The AI-written Summary of an ended Meeting, at most one per Meeting, with the
 * transcript counters it was written from so freshness can be checked cheaply.
 */
export const meetingSummaries = sqliteTable(
  "meeting_summaries",
  {
    id: text("id").notNull().primaryKey(),
    meetingId: text("meeting_id")
      .notNull()
      .references(() => meetings.id, { onDelete: "cascade" }),
    /** Concise prose overview of the Meeting. */
    summary: text("summary").notNull(),
    /**
     * The Meeting's key moments, in order. Null for a Summary written before
     * moments were asked for; an empty list when there were none to name.
     */
    moments: text("moments", { mode: "json" }).$type<MeetingMoment[] | null>(),
    /** Total duration in seconds */
    durationSeconds: integer("duration_seconds"),
    /** Number of participants */
    participantCount: integer("participant_count"),
    /** Number of participants represented by at least one transcript segment */
    transcribedParticipantCount: integer("transcribed_participant_count"),
    /** Transcript snapshot used to produce this summary */
    transcriptSegmentCount: integer("transcript_segment_count").notNull().default(0),
    transcriptLastUpdatedAt: integer("transcript_last_updated_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex("meeting_summaries_meeting_id_unique").on(table.meetingId),
    check(
      "meeting_summaries_duration_nonnegative_check",
      sql`${table.durationSeconds} IS NULL OR ${table.durationSeconds} >= 0`,
    ),
    check(
      "meeting_summaries_participant_count_nonnegative_check",
      sql`${table.participantCount} IS NULL OR ${table.participantCount} >= 0`,
    ),
    check(
      "meeting_summaries_transcribed_participant_count_nonnegative_check",
      sql`${table.transcribedParticipantCount} IS NULL OR ${table.transcribedParticipantCount} >= 0`,
    ),
    check(
      "meeting_summaries_transcript_segment_count_nonnegative_check",
      sql`${table.transcriptSegmentCount} >= 0`,
    ),
  ]
);

export type MeetingSummaryRow = typeof meetingSummaries.$inferSelect;

// ============================================================================
// MEETING FOLLOW-UPS (what people agreed to do, from the Summary)
// ============================================================================

/**
 * What people in a Meeting agreed to do, as Orb's Summary lists them, each
 * with whoever it falls to when the transcript says so. Anyone who can open
 * the Meeting can tick one off; ticking is shared, as the work is. A Summary
 * written again replaces the list but keeps what was already done.
 */
export const meetingFollowUps = sqliteTable(
  "meeting_follow_ups",
  {
    id: text("id").notNull().primaryKey(),
    meetingId: text("meeting_id")
      .notNull()
      .references(() => meetings.id, { onDelete: "cascade" }),
    /** Order within the Meeting's list, from 0. */
    position: integer("position").notNull(),
    text: text("text").notNull(),
    /** Who it falls to, by the name they had in the Meeting. Null when nobody was named. */
    ownerName: text("owner_name"),
    doneAt: integer("done_at", { mode: "timestamp" }),
    doneByUserId: text("done_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index("meeting_follow_ups_meeting_idx").on(table.meetingId, table.position),
    check("meeting_follow_ups_position_check", sql`${table.position} >= 0`),
    check(
      "meeting_follow_ups_text_length_check",
      sql`length(${table.text}) <= 300 AND length(trim(${table.text})) BETWEEN 1 AND 300`,
    ),
    check(
      "meeting_follow_ups_owner_name_length_check",
      sql`${table.ownerName} IS NULL OR length(${table.ownerName}) <= 200`,
    ),
    check(
      "meeting_follow_ups_done_shape_check",
      sql`${table.doneByUserId} IS NULL OR ${table.doneAt} IS NOT NULL`,
    ),
  ]
);

export type MeetingFollowUpRow = typeof meetingFollowUps.$inferSelect;
