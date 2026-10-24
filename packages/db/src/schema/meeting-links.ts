import { check, foreignKey, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import {
  JOIN_POLICIES as JOIN_POLICY_VALUES,
  MEETING_LINK_REUSE_POLICIES as MEETING_LINK_REUSE_POLICY_VALUES,
  SPACE_KINDS as SPACE_KIND_VALUES,
} from "@orbmeet/domain-model";
import { meetingCodeShape, oneOf, optionalTextLength } from "./columns.ts";
import { spaces } from "./spaces.ts";

// ============================================================================
// ENTRY: MEETING LINKS, DEFAULT LINK, SCHEDULES
// ============================================================================

/**
 * A meeting link is an entry credential and launch policy, never history. Its
 * code is the only identifier that appears in public URLs (`/abc-defg-hij`).
 * Link settings are defaults for the next Meeting; an open Meeting keeps the
 * snapshots it started with.
 */

export const meetingLinks = sqliteTable(
  "meeting_links",
  {
    id: text("id").notNull().primaryKey(),
    code: text("code").notNull().unique(),
    spaceId: text("space_id")
      .notNull()
      .references(() => spaces.id, { onDelete: "cascade" }),
    // Pinned copy of the immutable space kind (composite FK below). Lets the
    // guest-entry rule live in a CHECK on this table.
    spaceKind: text("space_kind", { enum: SPACE_KIND_VALUES }).notNull(),
    // `reusable` may create a sequence of Meetings. `one_time` may create
    // exactly one Meeting, then is spent.
    reusePolicy: text("reuse_policy", { enum: MEETING_LINK_REUSE_POLICY_VALUES })
      .default("one_time")
      .notNull(),
    // Set by the occurrence-acquisition batch when a one_time link mints its
    // meeting (guarded conditional update in the occurrence writer).
    spentAt: integer("spent_at", { mode: "timestamp" }),
    title: text("title"),
    allowGuests: integer("allow_guests", { mode: "boolean" }).notNull().default(false),
    joinPolicy: text("join_policy", { enum: JOIN_POLICY_VALUES }).notNull().default("open"),
    lastUsedAt: integer("last_used_at", { mode: "timestamp" }),
    expiresAt: integer("expires_at", { mode: "timestamp" }),
    archivedAt: integer("archived_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date())
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // Also backs the space_id FK (left-most column).
    index("meeting_links_space_reuse_archived_last_used_idx").on(
      table.spaceId,
      table.reusePolicy,
      table.archivedAt,
      table.lastUsedAt,
    ),
    // A Space and a person each have at most one active permanent meeting link. One-time
    // entry links remain separate credentials and are not constrained here.
    uniqueIndex("meeting_links_shared_space_unique_idx")
      .on(table.spaceId)
      .where(sql`${table.spaceKind} = 'shared'
        AND ${table.reusePolicy} = 'reusable'
        AND ${table.archivedAt} IS NULL`),
    uniqueIndex("meeting_links_personal_room_unique_idx")
      .on(table.spaceId)
      .where(sql`${table.spaceKind} = 'personal'
        AND ${table.reusePolicy} = 'reusable'
        AND ${table.archivedAt} IS NULL`),
    // Pin target: meetings and schedules pin their space to their link's space.
    uniqueIndex("meeting_links_id_space_unique_idx").on(table.id, table.spaceId),
    // Pin target: the default-link designation pins reuse_policy = 'reusable'.
    uniqueIndex("meeting_links_id_reuse_policy_unique_idx").on(table.id, table.reusePolicy),
    index("meeting_links_expires_at_idx").on(table.expiresAt),
    foreignKey({
      columns: [table.spaceId, table.spaceKind],
      foreignColumns: [spaces.id, spaces.kind],
      name: "meeting_links_space_kind_fk",
    }).onDelete("cascade"),
    check("meeting_links_code_shape_check", meetingCodeShape(table.code)),
    check("meeting_links_space_kind_check", oneOf(table.spaceKind, SPACE_KIND_VALUES)),
    check(
      "meeting_links_reuse_policy_check",
      oneOf(table.reusePolicy, MEETING_LINK_REUSE_POLICY_VALUES),
    ),
    check("meeting_links_join_policy_check", oneOf(table.joinPolicy, JOIN_POLICY_VALUES)),
    // Guest entry is a personal-space capability; shared-space entry is
    // member-guarded.
    check(
      "meeting_links_guest_entry_check",
      sql`${table.spaceKind} = 'personal' OR ${table.allowGuests} = 0`,
    ),
    check(
      "meeting_links_spent_shape_check",
      sql`${table.reusePolicy} = 'one_time' OR ${table.spentAt} IS NULL`,
    ),
    check("meeting_links_title_length_check", optionalTextLength(table.title, 200)),
    check(
      "meeting_links_expiry_after_created_check",
      sql`${table.expiresAt} IS NULL OR ${table.expiresAt} >= ${table.createdAt}`,
    ),
    check(
      "meeting_links_last_used_after_created_check",
      sql`${table.lastUsedAt} IS NULL OR ${table.lastUsedAt} >= ${table.createdAt}`,
    ),
    check(
      "meeting_links_last_used_before_expiry_check",
      sql`${table.expiresAt} IS NULL OR ${table.lastUsedAt} IS NULL OR ${table.lastUsedAt} <= ${table.expiresAt}`,
    ),
    check(
      "meeting_links_spent_after_created_check",
      sql`${table.spentAt} IS NULL OR ${table.spentAt} >= ${table.createdAt}`,
    ),
    check(
      "meeting_links_archived_after_created_check",
      sql`${table.archivedAt} IS NULL OR ${table.archivedAt} >= ${table.createdAt}`,
    ),
    check(
      "meeting_links_updated_after_created_check",
      sql`${table.updatedAt} >= ${table.createdAt}`,
    ),
  ]
);

/**
 * Designates the reusable front door of a shared Space. "Default" is a
 * relationship, not a kind of link. The pinned columns make "only a shared
 * Space designates" and "the designated link is reusable and belongs to that
 * Space" schema facts; non-expiring/non-archived is trigger-enforced in the
 * migration SQL because mutable columns cannot be pinned.
 */

export const spaceDefaultMeetingLinks = sqliteTable(
  "space_default_meeting_links",
  {
    spaceId: text("space_id")
      .notNull()
      .primaryKey()
      .references(() => spaces.id, { onDelete: "cascade" }),
    spaceKind: text("space_kind", { enum: SPACE_KIND_VALUES }).notNull(),
    meetingLinkId: text("meeting_link_id").notNull(),
    linkReusePolicy: text("link_reuse_policy", { enum: MEETING_LINK_REUSE_POLICY_VALUES }).notNull(),
  },
  (table) => [
    uniqueIndex("space_default_meeting_links_link_unique_idx").on(table.meetingLinkId),
    foreignKey({
      columns: [table.spaceId, table.spaceKind],
      foreignColumns: [spaces.id, spaces.kind],
      name: "space_default_meeting_links_space_kind_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.meetingLinkId, table.spaceId],
      foreignColumns: [meetingLinks.id, meetingLinks.spaceId],
      name: "space_default_meeting_links_link_space_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.meetingLinkId, table.linkReusePolicy],
      foreignColumns: [meetingLinks.id, meetingLinks.reusePolicy],
      name: "space_default_meeting_links_link_reuse_fk",
    }).onDelete("cascade"),
    check("space_default_meeting_links_kind_check", sql`${table.spaceKind} = 'shared'`),
    check(
      "space_default_meeting_links_reuse_check",
      sql`${table.linkReusePolicy} = 'reusable'`,
    ),
  ],
);

export type MeetingLink = typeof meetingLinks.$inferSelect;
export type SpaceDefaultMeetingLink = typeof spaceDefaultMeetingLinks.$inferSelect;
