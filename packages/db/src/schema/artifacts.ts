import { check, foreignKey, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { MEETING_ARTIFACT_TYPES as MEETING_ARTIFACT_TYPE_VALUES } from "@orbmeet/domain-model";
import { oneOf, requiredTrimmedTextLength } from "./columns.ts";
import { users } from "./identity.ts";
import { spaces } from "./spaces.ts";
import { meetings } from "./meetings.ts";
import { whiteboardRevisions } from "./whiteboards.ts";

// ============================================================================
// MEETING ARTIFACTS
// ============================================================================

/**
 * Registered outputs of meeting history: a `recording`, or the `whiteboard_pdf`
 * handout, both listed and downloadable under history access. Uploader columns
 * record provenance and storage accounting; they are never an authorization
 * rule.
 */

export const meetingArtifacts = sqliteTable(
  "meeting_artifacts",
  {
    id: text("id").notNull().primaryKey(),
    meetingId: text("meeting_id")
      .notNull()
      .references(() => meetings.id, { onDelete: "cascade" }),
    // Copied from meetings.spaceId at registration time for Space asset
    // feeds; pinned to the meeting row by the composite FK below.
    spaceId: text("space_id")
      .notNull()
      .references(() => spaces.id, { onDelete: "cascade" }),
    revisionId: text("revision_id").references(() => whiteboardRevisions.id, {
      onDelete: "set null",
    }),
    type: text("type", { enum: MEETING_ARTIFACT_TYPE_VALUES }).notNull(),
    r2Key: text("r2_key").notNull().unique(),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    size: integer("size").notNull(),
    uploadedByUserId: text("uploaded_by_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index("meeting_artifacts_meeting_id_created_at_idx").on(table.meetingId, table.createdAt),
    // Also backs the space_id FK (left-most column).
    index("meeting_artifacts_space_created_id_idx").on(table.spaceId, table.createdAt, table.id),
    index("meeting_artifacts_meeting_type_idx").on(table.meetingId, table.type),
    index("meeting_artifacts_revision_idx").on(table.revisionId),
    index("meeting_artifacts_uploader_meeting_size_idx").on(
      table.uploadedByUserId,
      table.meetingId,
      table.size,
    ),
    check("meeting_artifacts_type_check", oneOf(table.type, MEETING_ARTIFACT_TYPE_VALUES)),
    check("meeting_artifacts_size_nonnegative_check", sql`${table.size} >= 0`),
    check("meeting_artifacts_filename_length_check", requiredTrimmedTextLength(table.filename, 255)),
    check("meeting_artifacts_mime_type_length_check", requiredTrimmedTextLength(table.mimeType, 100)),
    check("meeting_artifacts_r2_key_length_check", sql`length(${table.r2Key}) <= 512`),
    // One retention-class prefix per type. The PDF handout is Meeting-owned
    // because it may combine several boards.
    check(
      "meeting_artifacts_r2_key_check",
      sql`(
        (${table.type} = 'recording'
          AND substr(${table.r2Key}, 1, 9) = 'meetings/'
          AND substr(${table.r2Key}, 10, length(${table.meetingId})) = ${table.meetingId}
          AND substr(${table.r2Key}, 10 + length(${table.meetingId}), 12) = '/recordings/')
        OR (${table.type} = 'whiteboard_pdf'
          AND (
            ${table.r2Key} = 'meetings/' || ${table.meetingId} || '/exports/whiteboard.pdf'
            OR (
              substr(${table.r2Key}, 1, 9 + length(${table.meetingId}) + 20)
                = 'meetings/' || ${table.meetingId} || '/exports/whiteboard/'
              AND length(${table.r2Key}) > 9 + length(${table.meetingId}) + 24
              AND substr(${table.r2Key}, -4) = '.pdf'
            )
          ))
      )`,
    ),
    foreignKey({
      columns: [table.meetingId, table.spaceId],
      foreignColumns: [meetings.id, meetings.spaceId],
      name: "meeting_artifacts_meeting_space_fk",
    }),
  ],
);

export type MeetingArtifact = typeof meetingArtifacts.$inferSelect;
