import {
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import {
  MEETING_WHITEBOARD_CAPTURE_STATUSES as MEETING_WHITEBOARD_CAPTURE_STATUS_VALUES,
  WHITEBOARD_ASSET_STATUSES as WHITEBOARD_ASSET_STATUS_VALUES,
  WHITEBOARD_FILE_ROLES as WHITEBOARD_FILE_ROLE_VALUES,
  WHITEBOARD_REVISION_KINDS as WHITEBOARD_REVISION_KIND_VALUES,
  WHITEBOARD_STATUSES as WHITEBOARD_STATUS_VALUES,
} from "@orbmeet/domain-model";
import {
  JSON_TEXT_MAX_LENGTH,
  oneOf,
  optionalExactTextLength,
  optionalTextLength,
  requiredTrimmedTextLength,
} from "./columns.ts";
import { users } from "./identity.ts";
import { spaces } from "./spaces.ts";
import { files } from "./assets.ts";
import { meetingAdmissions, meetings } from "./meetings.ts";

// ============================================================================
// MEETING WHITEBOARDS
// ============================================================================

/**
 * A durable editable visual document. A Whiteboard belongs to a Space, not to
 * a Meeting: the same document can be resumed across many occurrences. The
 * meeting_whiteboards aggregate below records each bounded use and pins an
 * immutable revision for Meeting history.
 *
 * `title` is NOT NULL because a Whiteboard now exists only because a person
 * decided to make one, and a person names what they make. The column was
 * nullable while Meetings created documents as a side effect, and the
 * created-at fallback that covered for it is why a picker could show six
 * indistinguishable rows. A board created inside a Meeting inherits that
 * Meeting's name — something semantically real, and editable in place.
 */

export const whiteboards = sqliteTable(
  "whiteboards",
  {
    id: text("id").notNull().primaryKey(),
    syncRoomId: text("sync_room_id").notNull().unique(),
    spaceId: text("space_id")
      .notNull()
      .references(() => spaces.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    status: text("status", { enum: WHITEBOARD_STATUS_VALUES })
      .notNull()
      .default("active"),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    archivedAt: integer("archived_at", { mode: "timestamp" }),
    /**
     * The node holding the board, which every command and token for it is
     * sent to: its room database there is the working copy, saved to R2 as
     * it changes. Null until the board is first used, and a node that leaves
     * the configuration is replaced on the board's next use.
     */
    syncNodeId: text("sync_node_id"),
    /**
     * Raised each time the board moves to another node. Commands and tokens
     * carry it, so a node holding an older copy loads the newest saved one,
     * and one the board has moved on from serves nothing more of it.
     */
    syncGeneration: integer("sync_generation").notNull().default(0),
    /**
     * Unused, and no longer written: a board's state is its room database on
     * the node holding it, not an R2 pointer this row could describe. Dropping the
     * columns means rebuilding this table, and a rebuild's DROP TABLE would
     * cascade into every table that references a board on D1, so it waits for
     * a migration that preserves child rows.
     */
    currentSnapshotR2Key: text("current_snapshot_r2_key"),
    currentSnapshotHash: text("current_snapshot_hash"),
    currentDocumentClock: integer("current_document_clock"),
    currentSnapshotSize: integer("current_snapshot_size"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date())
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("whiteboards_id_space_unique_idx").on(table.id, table.spaceId),
    index("whiteboards_space_status_updated_idx").on(table.spaceId, table.status, table.updatedAt),
    index("whiteboards_created_by_user_idx").on(table.createdByUserId),
    check("whiteboards_title_length_check", requiredTrimmedTextLength(table.title, 200)),
    check("whiteboards_sync_room_id_length_check", requiredTrimmedTextLength(table.syncRoomId, 64)),
    check("whiteboards_status_check", oneOf(table.status, WHITEBOARD_STATUS_VALUES)),
    check(
      "whiteboards_snapshot_hash_check",
      optionalExactTextLength(table.currentSnapshotHash, 32),
    ),
    check(
      "whiteboards_snapshot_r2_key_check",
      sql`${table.currentSnapshotR2Key} IS NULL
        OR ${table.currentSnapshotR2Key} = 'internal/whiteboards/' || ${table.id} || '/state/current.json'`,
    ),
    check(
      "whiteboards_document_clock_nonnegative_check",
      sql`${table.currentDocumentClock} IS NULL OR ${table.currentDocumentClock} >= 0`,
    ),
    check(
      "whiteboards_snapshot_size_nonnegative_check",
      sql`${table.currentSnapshotSize} IS NULL OR ${table.currentSnapshotSize} >= 0`,
    ),
    check(
      "whiteboards_status_shape_check",
      sql`(
        (${table.status} = 'active' AND ${table.archivedAt} IS NULL)
        OR (${table.status} = 'archived' AND ${table.archivedAt} IS NOT NULL)
      )`,
    ),
    check("whiteboards_archived_after_created_check", sql`${table.archivedAt} IS NULL OR ${table.archivedAt} >= ${table.createdAt}`),
    check("whiteboards_updated_after_created_check", sql`${table.updatedAt} >= ${table.createdAt}`),
  ],
);

/** Immutable snapshots pinned at meaningful collaboration boundaries. */

export const whiteboardRevisions = sqliteTable(
  "whiteboard_revisions",
  {
    id: text("id").notNull().primaryKey(),
    whiteboardId: text("whiteboard_id")
      .notNull()
      .references(() => whiteboards.id, { onDelete: "cascade" }),
    spaceId: text("space_id")
      .notNull()
      .references(() => spaces.id, { onDelete: "cascade" }),
    revisionNumber: integer("revision_number").notNull(),
    kind: text("kind", { enum: WHITEBOARD_REVISION_KIND_VALUES }).notNull(),
    sourceMeetingId: text("source_meeting_id").references(() => meetings.id, {
      onDelete: "set null",
    }),
    snapshotR2Key: text("snapshot_r2_key").notNull().unique(),
    snapshotHash: text("snapshot_hash"),
    // JSON array of document-asset R2 keys referenced by this immutable
    // revision. History authorization never falls through to the live board.
    assetManifest: text("asset_manifest"),
    documentClock: integer("document_clock"),
    snapshotSize: integer("snapshot_size").notNull(),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex("whiteboard_revisions_board_number_unique_idx").on(
      table.whiteboardId,
      table.revisionNumber,
    ),
    index("whiteboard_revisions_space_created_idx").on(table.spaceId, table.createdAt),
    index("whiteboard_revisions_meeting_idx").on(table.sourceMeetingId),
    index("whiteboard_revisions_created_by_idx").on(table.createdByUserId),
    foreignKey({
      columns: [table.whiteboardId, table.spaceId],
      foreignColumns: [whiteboards.id, whiteboards.spaceId],
      name: "whiteboard_revisions_board_space_fk",
    }).onDelete("cascade"),
    check("whiteboard_revisions_number_positive_check", sql`${table.revisionNumber} > 0`),
    check("whiteboard_revisions_kind_check", oneOf(table.kind, WHITEBOARD_REVISION_KIND_VALUES)),
    check("whiteboard_revisions_hash_check", optionalExactTextLength(table.snapshotHash, 32)),
    check(
      "whiteboard_revisions_asset_manifest_json_check",
      sql`${table.assetManifest} IS NULL OR (json_valid(${table.assetManifest}) AND json_type(${table.assetManifest}) = 'array')`,
    ),
    check(
      "whiteboard_revisions_asset_manifest_length_check",
      optionalTextLength(table.assetManifest, JSON_TEXT_MAX_LENGTH),
    ),
    check("whiteboard_revisions_snapshot_r2_key_length_check", sql`length(${table.snapshotR2Key}) <= 512`),
    // whiteboards/{whiteboardId}/revisions/…
    check(
      "whiteboard_revisions_snapshot_r2_key_check",
      sql`substr(${table.snapshotR2Key}, 1, 12) = 'whiteboards/'
        AND substr(${table.snapshotR2Key}, 13, length(${table.whiteboardId})) = ${table.whiteboardId}
        AND substr(${table.snapshotR2Key}, 13 + length(${table.whiteboardId}), 11) = '/revisions/'`,
    ),
    check(
      "whiteboard_revisions_document_clock_nonnegative_check",
      sql`${table.documentClock} IS NULL OR ${table.documentClock} >= 0`,
    ),
    check("whiteboard_revisions_snapshot_size_nonnegative_check", sql`${table.snapshotSize} >= 0`),
  ],
);

/**
 * One bounded use of a durable Whiteboard during a Meeting.
 *
 * The Space is pinned here so the database can enforce the aggregate boundary:
 * a Meeting only presents Whiteboards it owns. Selecting a Whiteboard from a
 * different Space creates an independent copy in the Meeting's Space first.
 */

export const meetingWhiteboards = sqliteTable(
  "meeting_whiteboards",
  {
    id: text("id").notNull().primaryKey(),
    meetingId: text("meeting_id")
      .notNull()
      .references(() => meetings.id, { onDelete: "cascade" }),
    spaceId: text("space_id")
      .notNull()
      .references(() => spaces.id, { onDelete: "cascade" }),
    whiteboardId: text("whiteboard_id")
      .notNull()
      .references(() => whiteboards.id, { onDelete: "restrict" }),
    titleAtUse: text("title_at_use"),
    titleAtEnd: text("title_at_end"),
    /**
     * Unused, and no longer written: capture now reuses a revision only when
     * that revision's own hash matches what was shared. Dropping the columns
     * means rebuilding this table, and a rebuild's DROP TABLE would cascade
     * into meeting_whiteboard_pages on D1, so it waits for a migration that
     * preserves child rows.
     */
    startRevisionId: text("start_revision_id").references(() => whiteboardRevisions.id, {
      onDelete: "set null",
    }),
    startSnapshotHash: text("start_snapshot_hash"),
    /**
     * One replaceable capture slot for the last state actually shared in this
     * Meeting. It is finalized into at most one numbered revision.
     */
    lastSharedSnapshotR2Key: text("last_shared_snapshot_r2_key"),
    lastSharedSnapshotHash: text("last_shared_snapshot_hash"),
    lastSharedDocumentClock: integer("last_shared_document_clock"),
    lastSharedSnapshotSize: integer("last_shared_snapshot_size"),
    lastSharedAt: integer("last_shared_at", { mode: "timestamp" }),
    allowParticipantCopy: integer("allow_participant_copy", { mode: "boolean" })
      .notNull()
      .default(true),
    capturedRevisionId: text("captured_revision_id").references(() => whiteboardRevisions.id, {
      onDelete: "set null",
    }),
    captureStatus: text("capture_status", { enum: MEETING_WHITEBOARD_CAPTURE_STATUS_VALUES })
      .notNull()
      .default("live"),
    captureFailureReason: text("capture_failure_reason"),
    attachedAt: integer("attached_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    lastPresentedAt: integer("last_presented_at", { mode: "timestamp" }),
    /**
     * Non-null on the one presentation the Meeting is currently focused on.
     * Focus is *not* an edit lease: every presented Whiteboard stays live and
     * editable, so switching focus is a pointer move rather than a handoff.
     */
    focusedAt: integer("focused_at", { mode: "timestamp" }),
    capturedAt: integer("captured_at", { mode: "timestamp" }),
  },
  (table) => [
    uniqueIndex("meeting_whiteboards_meeting_board_unique_idx").on(table.meetingId, table.whiteboardId),
    // A Meeting focuses at most one presentation at a time. Presenting a
    // different board clears this on the previous row in the same batch.
    uniqueIndex("meeting_whiteboards_focused_meeting_unique_idx")
      .on(table.meetingId)
      .where(sql`${table.focusedAt} IS NOT NULL`),
    uniqueIndex("meeting_whiteboards_id_meeting_unique_idx").on(table.id, table.meetingId),
    uniqueIndex("meeting_whiteboards_id_meeting_board_unique_idx").on(table.id, table.meetingId, table.whiteboardId),
    foreignKey({
      columns: [table.meetingId, table.spaceId],
      foreignColumns: [meetings.id, meetings.spaceId],
      name: "meeting_whiteboards_meeting_space_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.whiteboardId, table.spaceId],
      foreignColumns: [whiteboards.id, whiteboards.spaceId],
      name: "meeting_whiteboards_whiteboard_space_fk",
    }).onDelete("restrict"),
    index("meeting_whiteboards_meeting_attached_idx").on(table.meetingId, table.attachedAt),
    // Deleting a Space cascades here through space_id.
    index("meeting_whiteboards_space_idx").on(table.spaceId),
    index("meeting_whiteboards_board_attached_idx").on(table.whiteboardId, table.attachedAt),
    index("meeting_whiteboards_start_revision_idx").on(table.startRevisionId),
    index("meeting_whiteboards_captured_revision_idx").on(table.capturedRevisionId),
    check("meeting_whiteboards_title_at_use_length_check", optionalTextLength(table.titleAtUse, 200)),
    check("meeting_whiteboards_title_at_end_length_check", optionalTextLength(table.titleAtEnd, 200)),
    check("meeting_whiteboards_start_hash_check", optionalExactTextLength(table.startSnapshotHash, 32)),
    check("meeting_whiteboards_last_shared_hash_check", optionalExactTextLength(table.lastSharedSnapshotHash, 32)),
    check(
      "meeting_whiteboards_last_shared_clock_nonnegative_check",
      sql`${table.lastSharedDocumentClock} IS NULL OR ${table.lastSharedDocumentClock} >= 0`,
    ),
    check(
      "meeting_whiteboards_last_shared_size_nonnegative_check",
      sql`${table.lastSharedSnapshotSize} IS NULL OR ${table.lastSharedSnapshotSize} >= 0`,
    ),
    check(
      "meeting_whiteboards_last_shared_shape_check",
      sql`(
        (${table.lastSharedSnapshotR2Key} IS NULL
          AND ${table.lastSharedSnapshotHash} IS NULL
          AND ${table.lastSharedDocumentClock} IS NULL
          AND ${table.lastSharedSnapshotSize} IS NULL
          AND ${table.lastSharedAt} IS NULL)
        OR (${table.lastSharedSnapshotR2Key} IS NOT NULL
          AND ${table.lastSharedSnapshotHash} IS NOT NULL
          AND ${table.lastSharedSnapshotSize} IS NOT NULL
          AND ${table.lastSharedAt} IS NOT NULL)
      )`,
    ),
    check(
      "meeting_whiteboards_last_shared_key_check",
      sql`${table.lastSharedSnapshotR2Key} IS NULL OR (
        substr(${table.lastSharedSnapshotR2Key}, 1, 18) = 'internal/meetings/'
        AND instr(${table.lastSharedSnapshotR2Key}, '/canvases/') > 18
      )`,
    ),
    check("meeting_whiteboards_capture_status_check", oneOf(table.captureStatus, MEETING_WHITEBOARD_CAPTURE_STATUS_VALUES)),
    check("meeting_whiteboards_failure_reason_length_check", optionalTextLength(table.captureFailureReason, 1000)),
    check(
      "meeting_whiteboards_capture_shape_check",
      sql`(
        (${table.captureStatus} IN ('live', 'capturing') AND ${table.capturedAt} IS NULL AND ${table.capturedRevisionId} IS NULL)
        OR (${table.captureStatus} = 'captured' AND ${table.capturedAt} IS NOT NULL AND ${table.capturedRevisionId} IS NOT NULL AND ${table.captureFailureReason} IS NULL)
        OR (${table.captureStatus} = 'failed' AND ${table.capturedAt} IS NULL AND ${table.capturedRevisionId} IS NULL AND ${table.captureFailureReason} IS NOT NULL)
      )`,
    ),
  ],
);

// A Whiteboard's mutability is not leased to a Meeting. Its sync room is
// always live and authorization is `space membership OR active meeting grant`,
// so there is no exclusive write lease to model: documents outlive events.
// Which board a Meeting is looking at lives on `meeting_whiteboards.focused_at`;
// disposable panel visibility lives on `meeting_whiteboard_surfaces`.

/** Pages intentionally included in this Meeting's handout/capture. */

export const meetingWhiteboardPages = sqliteTable(
  "meeting_whiteboard_pages",
  {
    meetingWhiteboardId: text("meeting_whiteboard_id")
      .notNull()
      .references(() => meetingWhiteboards.id, { onDelete: "cascade" }),
    pageId: text("page_id").notNull(),
    firstPresentedAt: integer("first_presented_at", { mode: "timestamp" }),
    firstEditedAt: integer("first_edited_at", { mode: "timestamp" }),
    handoutOrder: integer("handout_order"),
  },
  (table) => [
    uniqueIndex("meeting_whiteboard_pages_usage_page_unique_idx").on(table.meetingWhiteboardId, table.pageId),
    index("meeting_whiteboard_pages_handout_idx").on(table.meetingWhiteboardId, table.handoutOrder),
    check("meeting_whiteboard_pages_page_id_length_check", requiredTrimmedTextLength(table.pageId, 128)),
    check("meeting_whiteboard_pages_handout_order_nonnegative_check", sql`${table.handoutOrder} IS NULL OR ${table.handoutOrder} >= 0`),
  ],
);

/**
 * An object embedded in a Whiteboard document. The Whiteboard owns the object;
 * uploader columns are provenance and quota attribution only. Pending rows are
 * durable upload intents and are safe to reap after expiresAt (the staging/
 * lifecycle rule additionally expires the R2 object itself).
 */

export const whiteboardAssets = sqliteTable(
  "whiteboard_assets",
  {
    id: text("id").notNull().primaryKey(),
    whiteboardId: text("whiteboard_id")
      .notNull()
      .references(() => whiteboards.id, { onDelete: "cascade" }),
    spaceId: text("space_id")
      .notNull()
      .references(() => spaces.id, { onDelete: "cascade" }),
    r2Key: text("r2_key").notNull().unique(),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    size: integer("size").notNull(),
    status: text("status", { enum: WHITEBOARD_ASSET_STATUS_VALUES })
      .notNull()
      .default("pending"),
    uploadedByUserId: text("uploaded_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    guestAdmissionId: text("guest_admission_id").references(() => meetingAdmissions.id, {
      onDelete: "set null",
    }),
    expiresAt: integer("expires_at", { mode: "timestamp" }),
    committedAt: integer("committed_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index("whiteboard_assets_board_status_idx").on(table.whiteboardId, table.status),
    index("whiteboard_assets_space_created_idx").on(table.spaceId, table.createdAt),
    index("whiteboard_assets_uploader_status_size_idx").on(
      table.uploadedByUserId,
      table.status,
      table.size,
    ),
    index("whiteboard_assets_guest_admission_idx").on(table.guestAdmissionId),
    index("whiteboard_assets_pending_expiry_idx").on(table.status, table.expiresAt),
    foreignKey({
      columns: [table.whiteboardId, table.spaceId],
      foreignColumns: [whiteboards.id, whiteboards.spaceId],
      name: "whiteboard_assets_board_space_fk",
    }).onDelete("cascade"),
    check("whiteboard_assets_status_check", oneOf(table.status, WHITEBOARD_ASSET_STATUS_VALUES)),
    check("whiteboard_assets_size_nonnegative_check", sql`${table.size} >= 0`),
    check("whiteboard_assets_filename_length_check", requiredTrimmedTextLength(table.filename, 255)),
    check("whiteboard_assets_mime_type_length_check", requiredTrimmedTextLength(table.mimeType, 100)),
    check("whiteboard_assets_r2_key_length_check", sql`length(${table.r2Key}) <= 512`),
    // whiteboards/{whiteboardId}/assets/…
    check(
      "whiteboard_assets_r2_key_check",
      sql`substr(${table.r2Key}, 1, 12) = 'whiteboards/'
        AND substr(${table.r2Key}, 13, length(${table.whiteboardId})) = ${table.whiteboardId}
        AND substr(${table.r2Key}, 13 + length(${table.whiteboardId}), 8) = '/assets/'`,
    ),
    check(
      "whiteboard_assets_status_shape_check",
      sql`(
        (${table.status} = 'pending' AND ${table.expiresAt} IS NOT NULL AND ${table.committedAt} IS NULL)
        OR (${table.status} = 'committed' AND ${table.expiresAt} IS NULL AND ${table.committedAt} IS NOT NULL)
        OR (${table.status} = 'deleting' AND ${table.expiresAt} IS NOT NULL)
      )`,
    ),
    check(
      "whiteboard_assets_uploader_shape_check",
      sql`NOT (${table.uploadedByUserId} IS NOT NULL AND ${table.guestAdmissionId} IS NOT NULL)`,
    ),
    check(
      "whiteboard_assets_expiry_after_created_check",
      sql`${table.expiresAt} IS NULL OR ${table.expiresAt} > ${table.createdAt}`,
    ),
    check(
      "whiteboard_assets_commit_after_created_check",
      sql`${table.committedAt} IS NULL OR ${table.committedAt} >= ${table.createdAt}`,
    ),
  ],
);

/**
 * Normalized pins from immutable revisions to their retained asset objects.
 *
 * The manifest remains the read-side authorization payload. This table is the
 * deletion-side synchronization primitive: a revision and its pins commit in
 * one D1 batch, while the R2 deletion saga refuses to cross a pinned key.
 */

export const whiteboardRevisionAssetReferences = sqliteTable(
  "whiteboard_revision_asset_references",
  {
    revisionId: text("revision_id")
      .notNull()
      .references(() => whiteboardRevisions.id, { onDelete: "cascade" }),
    // A copied Whiteboard can deliberately outlive the source Whiteboard that
    // originally registered these immutable bytes. Authorization is enforced
    // by the committed-asset/reference triggers; an FK to whiteboard_assets
    // would make the source registry row an accidental lifetime owner.
    r2Key: text("r2_key").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    primaryKey({
      columns: [table.revisionId, table.r2Key],
      name: "whiteboard_revision_asset_references_pk",
    }),
    index("whiteboard_revision_asset_references_key_idx").on(table.r2Key),
    check(
      "whiteboard_revision_asset_references_r2_key_check",
      sql`substr(${table.r2Key}, 1, 12) = 'whiteboards/'
        AND instr(${table.r2Key}, '/assets/') > 12`,
    ),
  ],
);

/**
 * Copy-on-write reference from one Whiteboard to immutable asset bytes uploaded
 * by another. Duplicating a Whiteboard copies its small document snapshot but
 * never its PDF page images or other embedded objects.
 *
 * sourceWhiteboardId is provenance rather than ownership, so it deliberately
 * has no FK: deleting the source Whiteboard must not invalidate a surviving copy.
 */

export const whiteboardAssetReferences = sqliteTable(
  "whiteboard_asset_references",
  {
    id: text("id").notNull().primaryKey(),
    whiteboardId: text("whiteboard_id")
      .notNull()
      .references(() => whiteboards.id, { onDelete: "cascade" }),
    sourceWhiteboardId: text("source_whiteboard_id").notNull(),
    r2Key: text("r2_key").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex("whiteboard_asset_references_board_key_unique_idx")
      .on(table.whiteboardId, table.r2Key),
    index("whiteboard_asset_references_source_idx")
      .on(table.sourceWhiteboardId, table.r2Key),
    check(
      "whiteboard_asset_references_different_board_check",
      sql`${table.whiteboardId} <> ${table.sourceWhiteboardId}`,
    ),
    check(
      "whiteboard_asset_references_r2_key_check",
      sql`substr(${table.r2Key}, 1, 12) = 'whiteboards/'
        AND instr(${table.r2Key}, '/assets/') > 12`,
    ),
  ],
);

/** Durable relationship between a Whiteboard and a reusable source File. */

export const whiteboardFileReferences = sqliteTable(
  "whiteboard_file_references",
  {
    whiteboardId: text("whiteboard_id")
      .notNull()
      .references(() => whiteboards.id, { onDelete: "cascade" }),
    fileId: text("file_id")
      .notNull()
      .references(() => files.id, { onDelete: "cascade" }),
    spaceId: text("space_id")
      .notNull()
      .references(() => spaces.id, { onDelete: "cascade" }),
    role: text("role", { enum: WHITEBOARD_FILE_ROLE_VALUES }).notNull().default("source"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    primaryKey({
      columns: [table.whiteboardId, table.fileId],
      name: "whiteboard_file_references_pk",
    }),
    index("whiteboard_file_references_file_idx").on(table.fileId),
    index("whiteboard_file_references_space_idx").on(table.spaceId),
    foreignKey({
      columns: [table.whiteboardId, table.spaceId],
      foreignColumns: [whiteboards.id, whiteboards.spaceId],
      name: "whiteboard_file_references_whiteboard_space_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.fileId, table.spaceId],
      foreignColumns: [files.id, files.spaceId],
      name: "whiteboard_file_references_file_space_fk",
    }).onDelete("cascade"),
    check("whiteboard_file_references_role_check", oneOf(table.role, WHITEBOARD_FILE_ROLE_VALUES)),
  ],
);

/**
 * Retired: board edit approval is now `meeting_admissions.whiteboard_edit_granted`,
 * decided by the Meeting's coordinator. Nothing reads or writes this table; it
 * stays only so the migration that stopped using it runs safely under the code
 * deployed before it, and is dropped by the next migration that reshapes the
 * Meeting tables.
 */

export const whiteboardEditGrants = sqliteTable(
  "whiteboard_edit_grants",
  {
    id: text("id").notNull().primaryKey(),
    whiteboardId: text("whiteboard_id")
      .notNull()
      .references(() => whiteboards.id, { onDelete: "cascade" }),
    meetingId: text("meeting_id")
      .notNull()
      .references(() => meetings.id, { onDelete: "cascade" }),
    meetingWhiteboardId: text("meeting_whiteboard_id")
      .notNull()
      .references(() => meetingWhiteboards.id, { onDelete: "cascade" }),
    // Exactly one of userId / admissionId — real FKs instead of a polymorphic
    // principal pair, so revoking a guest's admission cascades their grant.
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    admissionId: text("admission_id").references(() => meetingAdmissions.id, {
      onDelete: "cascade",
    }),
    grantedByUserId: text("granted_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    grantedAt: integer("granted_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    revokedAt: integer("revoked_at", { mode: "timestamp" }),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date())
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("whiteboard_edit_grants_meeting_board_idx").on(table.meetingId, table.whiteboardId),
    // Back the whiteboardId CASCADE FK. whiteboard_edit_grants_meeting_board_idx
    // is led by meeting_id, so deleting a whiteboard (space/account teardown)
    // would otherwise full-scan this table.
    index("whiteboard_edit_grants_whiteboard_idx").on(table.whiteboardId),
    index("whiteboard_edit_grants_usage_idx").on(table.meetingWhiteboardId),
    index("whiteboard_edit_grants_user_idx").on(table.userId),
    index("whiteboard_edit_grants_admission_idx").on(table.admissionId),
    index("whiteboard_edit_grants_granted_by_idx").on(table.grantedByUserId),
    uniqueIndex("whiteboard_edit_grants_active_user_unique_idx")
      .on(table.meetingWhiteboardId, table.userId)
      .where(sql`${table.revokedAt} IS NULL`),
    uniqueIndex("whiteboard_edit_grants_active_admission_unique_idx")
      .on(table.meetingWhiteboardId, table.admissionId)
      .where(sql`${table.revokedAt} IS NULL`),
    foreignKey({
      columns: [table.meetingWhiteboardId, table.meetingId, table.whiteboardId],
      foreignColumns: [meetingWhiteboards.id, meetingWhiteboards.meetingId, meetingWhiteboards.whiteboardId],
      name: "whiteboard_edit_grants_usage_meeting_fk",
    }).onDelete("cascade"),
    check(
      "whiteboard_edit_grants_principal_shape_check",
      sql`(
        (${table.userId} IS NOT NULL AND ${table.admissionId} IS NULL)
        OR (${table.userId} IS NULL AND ${table.admissionId} IS NOT NULL)
      )`,
    ),
    check(
      "whiteboard_edit_grants_revoked_after_granted_check",
      sql`${table.revokedAt} IS NULL OR ${table.revokedAt} >= ${table.grantedAt}`,
    ),
  ],
);

/**
 * Per-principal, per-day AI request and output-token reservations. Defined but
 * not yet read or written: the assistant is limited only by an in-memory rate
 * limiter on each sync node, and nothing yet charges AI use to a payer.
 */
export const whiteboardAiUsage = sqliteTable(
  "whiteboard_ai_usage",
  {
    id: text("id").notNull().primaryKey(),
    principal: text("principal").notNull(),
    usageDay: text("usage_day").notNull(),
    requestCount: integer("request_count").default(0).notNull(),
    reservedOutputTokens: integer("reserved_output_tokens").default(0).notNull(),
    leaseExpiresAt: integer("lease_expires_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date())
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("whiteboard_ai_usage_principal_day_unique").on(
      table.principal,
      table.usageDay,
    ),
    index("whiteboard_ai_usage_day_idx").on(table.usageDay),
    check("whiteboard_ai_usage_request_count_nonnegative_check", sql`${table.requestCount} >= 0`),
    check(
      "whiteboard_ai_usage_reserved_tokens_nonnegative_check",
      sql`${table.reservedOutputTokens} >= 0`,
    ),
    check("whiteboard_ai_usage_principal_length_check", requiredTrimmedTextLength(table.principal, 255)),
    check("whiteboard_ai_usage_day_length_check", sql`length(${table.usageDay}) = 10`),
  ],
);

export type Whiteboard = typeof whiteboards.$inferSelect;
export type WhiteboardRevision = typeof whiteboardRevisions.$inferSelect;
export type MeetingWhiteboard = typeof meetingWhiteboards.$inferSelect;
export type MeetingWhiteboardPage = typeof meetingWhiteboardPages.$inferSelect;
export type WhiteboardAsset = typeof whiteboardAssets.$inferSelect;
export type WhiteboardAssetReference = typeof whiteboardAssetReferences.$inferSelect;
export type WhiteboardFileReference = typeof whiteboardFileReferences.$inferSelect;
export type WhiteboardEditGrant = typeof whiteboardEditGrants.$inferSelect;
export type WhiteboardAiUsage = typeof whiteboardAiUsage.$inferSelect;
