import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import {
  FILE_MIME_TYPES as FILE_MIME_TYPE_VALUES,
  FILE_STATUSES as FILE_STATUS_VALUES,
  FILE_TYPES as FILE_TYPE_VALUES,
} from "@orbmeet/domain-model";
import { oneOf, optionalExactTextLength, requiredTrimmedTextLength } from "./columns.ts";
import { users } from "./identity.ts";
import { spaces } from "./spaces.ts";

// ============================================================================
// ASSETS
// ============================================================================
// Files people upload into a Space, and the reservations that bound an upload
// before its object exists.

/**
 * A reusable immutable source object. Personal work is stored in the user's
 * hidden personal Space, so the same ownership and access rules apply to both
 * personal and shared Files without a polymorphic foreign key.
 */
export const files = sqliteTable(
  "files",
  {
    id: text("id").notNull().primaryKey(),
    spaceId: text("space_id")
      .notNull()
      .references(() => spaces.id, { onDelete: "cascade" }),
    type: text("type", { enum: FILE_TYPE_VALUES }).notNull(),
    status: text("status", { enum: FILE_STATUS_VALUES }).notNull().default("committed"),
    r2Key: text("r2_key").notNull().unique(),
    filename: text("filename").notNull(),
    mimeType: text("mime_type", { enum: FILE_MIME_TYPE_VALUES }).notNull(),
    size: integer("size").notNull(),
    contentHash: text("content_hash"),
    uploadedByUserId: text("uploaded_by_id").references(() => users.id, {
      onDelete: "set null",
    }),
    expiresAt: integer("expires_at", { mode: "timestamp" }),
    committedAt: integer("committed_at", { mode: "timestamp" })
      .$defaultFn(() => new Date()),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    // Supports tuple references that need both the file and its owning Space.
    uniqueIndex("files_id_space_unique_idx").on(table.id, table.spaceId),
    // Left-most space_id backs the Space FK as well as the status listing path.
    index("files_space_status_created_idx").on(table.spaceId, table.status, table.createdAt),
    // Quota checks aggregate committed bytes by uploader. Left-most uploader
    // still backs the user FK while status/size make the aggregate covering.
    index("files_uploader_status_size_idx").on(table.uploadedByUserId, table.status, table.size),
    index("files_pending_expiry_idx").on(table.status, table.expiresAt),
    index("files_content_hash_idx").on(table.contentHash),
    check("files_status_check", oneOf(table.status, FILE_STATUS_VALUES)),
    check("files_type_check", oneOf(table.type, FILE_TYPE_VALUES)),
    check("files_mime_type_check", oneOf(table.mimeType, FILE_MIME_TYPE_VALUES)),
    check("files_size_nonnegative_check", sql`${table.size} >= 0`),
    check("files_content_hash_check", optionalExactTextLength(table.contentHash, 64)),
    check("files_filename_length_check", requiredTrimmedTextLength(table.filename, 255)),
    check("files_r2_key_length_check", sql`length(${table.r2Key}) <= 512`),
    check(
      "files_r2_key_check",
      sql`substr(${table.r2Key}, 1, 7) = 'spaces/'
        AND substr(${table.r2Key}, 8, length(${table.spaceId})) = ${table.spaceId}
        AND substr(${table.r2Key}, 8 + length(${table.spaceId}), 9) = '/uploads/'`,
    ),
    check(
      "files_status_shape_check",
      sql`(
        (${table.status} = 'pending' AND ${table.expiresAt} IS NOT NULL AND ${table.committedAt} IS NULL)
        OR (${table.status} = 'committed' AND ${table.expiresAt} IS NULL AND ${table.committedAt} IS NOT NULL)
        OR (${table.status} = 'deleting' AND ${table.expiresAt} IS NOT NULL)
      )`,
    ),
    check(
      "files_expiry_after_created_check",
      sql`${table.expiresAt} IS NULL OR ${table.expiresAt} > ${table.createdAt}`,
    ),
    check(
      "files_commit_after_created_check",
      sql`${table.committedAt} IS NULL OR ${table.committedAt} >= ${table.createdAt}`,
    ),
  ]
);

/**
 * Bytes promised to an upload in progress, per storage principal
 * (`user:<id>` or `organization:<id>`). Quota checks add live reservations to
 * stored bytes, so concurrent uploads cannot together exceed the limit.
 */
export const uploadReservations = sqliteTable(
  "upload_reservations",
  {
    id: text("id").notNull().primaryKey(),
    principal: text("principal").notNull(),
    scope: text("scope").notNull(),
    bytes: integer("bytes").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index("upload_reservations_principal_expires_idx").on(table.principal, table.expiresAt),
    index("upload_reservations_expires_idx").on(table.expiresAt),
    check("upload_reservations_principal_length_check", requiredTrimmedTextLength(table.principal, 255)),
    check("upload_reservations_scope_length_check", requiredTrimmedTextLength(table.scope, 255)),
    check("upload_reservations_bytes_positive_check", sql`${table.bytes} > 0`),
    check("upload_reservations_expires_after_created_check", sql`${table.expiresAt} > ${table.createdAt}`),
  ],
);

export type File = typeof files.$inferSelect;
export type UploadReservation = typeof uploadReservations.$inferSelect;
