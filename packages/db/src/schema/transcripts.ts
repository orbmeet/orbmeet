import { check, foreignKey, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { JSON_TEXT_MAX_LENGTH, optionalTextLength, requiredTrimmedTextLength } from "./columns.ts";
import { meetingAdmissions, meetingConnections, meetings } from "./meetings.ts";

// ============================================================================
// TRANSCRIPTS (final Deepgram segments)
// ============================================================================

/**
 * Final transcript segments as Deepgram returned them, attributed to the
 * admission and connection that spoke them. Ingestion is idempotent by
 * `(meeting_id, segment_id)`.
 */
export const transcripts = sqliteTable(
  "transcripts",
  {
    id: text("id").notNull().primaryKey(),
    meetingId: text("meeting_id")
      .notNull()
      .references(() => meetings.id, { onDelete: "cascade" }),
    admissionId: text("admission_id").references(() => meetingAdmissions.id, {
      onDelete: "set null",
    }),
    connectionId: text("connection_id").references(() => meetingConnections.id, {
      onDelete: "set null",
    }),
    /** LiveKit participant identity (e.g. user ID or guest identity) */
    participantIdentity: text("participant_identity").notNull(),
    /** Display name at the time of transcription */
    participantName: text("participant_name").notNull(),
    /** The transcribed text */
    text: text("text").notNull(),
    /** Deepgram/LiveKit segment ID for idempotent ingestion. */
    segmentId: text("segment_id").notNull(),
    /** Language code detected/used for this segment */
    language: text("language"),
    /** Speaker ID from diarization (when enabled) */
    speakerId: text("speaker_id"),
    /**
     * When the segment's audio was captured, in milliseconds: speakers overlap
     * within a second, and whole seconds cannot order them. `updated_at` is
     * the ingest time and stays in seconds, like every other row's.
     */
    startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date())
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // Transcript ingestion is the platform's dominant D1 write, and every
    // index here charges one extra row written per inserted segment. Keep this
    // list to what queries actually use: the (meeting_id, started_at, id)
    // pagination path, the segment-id idempotency check, and the two
    // single-column FK backers below. Per-participant/admission/connection
    // read paths don't exist today — reintroduce a composite only alongside
    // the query that needs it.
    index("transcripts_meeting_id_started_at_id_idx").on(table.meetingId, table.startedAt, table.id),
    uniqueIndex("transcripts_segment_id_unique").on(table.meetingId, table.segmentId),
    // Back the admission_id / connection_id FK set-null actions. Deleting an
    // admission or connection (Space or Meeting teardown) otherwise
    // full-scans transcripts.
    index("transcripts_admission_id_idx").on(table.admissionId),
    index("transcripts_connection_id_idx").on(table.connectionId),
    check(
      "transcripts_updated_after_started_check",
      sql`${table.updatedAt} >= ${table.startedAt} / 1000`,
    ),
    check("transcripts_participant_identity_length_check", requiredTrimmedTextLength(table.participantIdentity, 200)),
    check("transcripts_participant_name_length_check", requiredTrimmedTextLength(table.participantName, 100)),
    check("transcripts_text_length_check", requiredTrimmedTextLength(table.text, JSON_TEXT_MAX_LENGTH)),
    check("transcripts_segment_id_length_check", requiredTrimmedTextLength(table.segmentId, 255)),
    check("transcripts_language_length_check", optionalTextLength(table.language, 35)),
    check("transcripts_speaker_id_length_check", optionalTextLength(table.speakerId, 200)),
    foreignKey({
      columns: [table.admissionId, table.meetingId],
      foreignColumns: [meetingAdmissions.id, meetingAdmissions.meetingId],
      name: "transcripts_admission_meeting_fk",
    }),
    foreignKey({
      columns: [table.connectionId, table.meetingId],
      foreignColumns: [meetingConnections.id, meetingConnections.meetingId],
      name: "transcripts_connection_meeting_fk",
    }),
  ]
);

export type Transcript = typeof transcripts.$inferSelect;
