import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import {
  SPACE_AUDIT_ACTIONS as SPACE_AUDIT_ACTION_VALUES,
  SPACE_KINDS as SPACE_KIND_VALUES,
  SPACE_MEMBERSHIP_ROLES as SPACE_MEMBERSHIP_ROLE_VALUES,
} from "@orbmeet/domain-model";
import {
  JSON_TEXT_MAX_LENGTH,
  oneOf,
  optionalTextLength,
  requiredTrimmedTextLength,
} from "./columns.ts";
import { users } from "./identity.ts";
import { organizations } from "./organizations.ts";

// ============================================================================
// SPACES
// ============================================================================
//
// Every resource in the product belongs to exactly one Space. A personal
// space is created with the account and is hidden in the UI; a shared space
// is the visible collaboration context. Billing is resolved at the space:
// ownerUserId (user-billed, including every personal space) XOR
// organizationId (org-billed shared spaces).

export const spaces = sqliteTable(
  "spaces",
  {
    id: text("id").notNull().primaryKey(),
    kind: text("kind", { enum: SPACE_KIND_VALUES }).notNull(),
    name: text("name").notNull(),
    description: text("description"),
    // Deleting a user or organization must first purge its spaces through the
    // orchestrated deletion path ("cascade down, restrict up").
    ownerUserId: text("owner_user_id")
      .references(() => users.id, { onDelete: "restrict" }),
    organizationId: text("organization_id").references(() => organizations.id, { onDelete: "restrict" }),
    // URL slug derived from name at creation; stable — rename does not change
    // it. Shared spaces always have one; personal spaces never do.
    slug: text("slug"),
    // Default IANA timezone for schedules created in this Space.
    timeZone: text("time_zone").notNull().default("UTC"),
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
    index("spaces_organization_id_idx").on(table.organizationId),
    // Also backs the owner_user_id FK (left-most column).
    index("spaces_owner_archived_idx").on(table.ownerUserId, table.archivedAt),
    // The minute maintenance sweep asks only for archived Spaces in archival
    // order. Keep live/personal Spaces out of this index entirely.
    index("spaces_archived_at_id_idx")
      .on(table.archivedAt, table.id)
      .where(sql`${table.archivedAt} IS NOT NULL`),
    // Exactly one personal space per user.
    uniqueIndex("spaces_personal_owner_unique_idx")
      .on(table.ownerUserId)
      .where(sql`${table.kind} = 'personal'`),
    uniqueIndex("spaces_slug_unique_idx").on(table.slug),
    // Pin target: children denormalize the immutable kind via composite FK
    // (meeting_links, meetings, space_default_meeting_links).
    uniqueIndex("spaces_id_kind_unique_idx").on(table.id, table.kind),
    check("spaces_kind_check", oneOf(table.kind, SPACE_KIND_VALUES)),
    check(
      "spaces_owner_shape_check",
      sql`(
        (${table.ownerUserId} IS NOT NULL AND ${table.organizationId} IS NULL)
        OR (${table.ownerUserId} IS NULL AND ${table.organizationId} IS NOT NULL)
      )`,
    ),
    // Shared spaces have slugs; personal spaces never do.
    check("spaces_slug_shape_check", sql`(${table.kind} = 'personal') = (${table.slug} IS NULL)`),
    // A personal space is user-billed and lives and dies with the account
    // rather than being archived.
    check(
      "spaces_personal_shape_check",
      sql`${table.kind} = 'shared' OR (
        ${table.ownerUserId} IS NOT NULL
        AND ${table.archivedAt} IS NULL
      )`,
    ),
    check("spaces_name_length_check", requiredTrimmedTextLength(table.name, 200)),
    check("spaces_description_length_check", optionalTextLength(table.description, 1000)),
    check("spaces_slug_length_check", optionalTextLength(table.slug, 200)),
    check("spaces_time_zone_length_check", requiredTrimmedTextLength(table.timeZone, 100)),
    check("spaces_updated_after_created_check", sql`${table.updatedAt} >= ${table.createdAt}`),
    check(
      "spaces_archived_after_created_check",
      sql`${table.archivedAt} IS NULL OR ${table.archivedAt} >= ${table.createdAt}`,
    ),
  ]
);

/**
 * A person's membership of a Space: the content-access axis. Organization
 * roles never imply one. `role` is `admin` or `member`; the Space's owner is
 * named on the Space and holds an `admin` membership.
 */
export const spaceMembers = sqliteTable(
  "space_members",
  {
    id: text("id").notNull().primaryKey(),
    spaceId: text("space_id")
      .notNull()
      .references(() => spaces.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role", { enum: SPACE_MEMBERSHIP_ROLE_VALUES })
      .default("member")
      .notNull(),
    joinedAt: integer("joined_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index("space_members_user_id_idx").on(table.userId),
    uniqueIndex("space_members_unique_idx").on(table.spaceId, table.userId),
    check("space_members_role_check", oneOf(table.role, SPACE_MEMBERSHIP_ROLE_VALUES)),
  ]
);

/** A Space's one durable invitation link for joining as a member. */
export const spaceInvites = sqliteTable(
  "space_invites",
  {
    id: text("id").notNull().primaryKey(),
    spaceId: text("space_id")
      .notNull()
      .references(() => spaces.id, { onDelete: "cascade" }),
    // This invite code is intentionally retrievable: administrators must be able
    // to copy the same durable invitation URL (…/join/<code>) until they
    // explicitly rotate it. Rotation atomically replaces the code. It is 8 letters
    // over a 52-letter alphabet (~46 bits) — see generateInviteCode.
    token: text("token").notNull().unique(),
    createdByUserId: text("created_by_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex("space_invites_space_id_unique_idx").on(table.spaceId),
    // Backs the created_by_id FK set-null on user deletion.
    index("space_invites_created_by_id_idx").on(table.createdByUserId),
    check("space_invites_token_length_check", sql`length(${table.token}) = 8`),
  ]
);

// Governance trail for a space: who added/removed/promoted whom, who created or
// revoked an invite. Rows cascade with the space (so a hard delete leaves no
// audit — intentional, see SPACE_AUDIT_ACTIONS), and the actor is SET NULL on
// account deletion so the trail survives the user.
export const spaceAuditEvents = sqliteTable(
  "space_audit_events",
  {
    id: text("id").notNull().primaryKey(),
    spaceId: text("space_id")
      .notNull()
      .references(() => spaces.id, { onDelete: "cascade" }),
    actorUserId: text("actor_id").references(() => users.id, { onDelete: "set null" }),
    action: text("action", { enum: SPACE_AUDIT_ACTION_VALUES }).notNull(),
    // The user the action was taken on (member added/removed/promoted), when applicable.
    targetUserId: text("target_id").references(() => users.id, { onDelete: "set null" }),
    metadata: text("metadata"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index("space_audit_events_space_created_id_idx").on(table.spaceId, table.createdAt, table.id),
    index("space_audit_events_space_action_idx").on(table.spaceId, table.action),
    // Back the actor_id / target_id FK set-null actions so user deletion does not
    // full-scan the audit log (which it must, to preserve the trail past the user).
    index("space_audit_events_actor_id_idx").on(table.actorUserId),
    index("space_audit_events_target_id_idx").on(table.targetUserId),
    check("space_audit_events_action_check", oneOf(table.action, SPACE_AUDIT_ACTION_VALUES)),
    check(
      "space_audit_events_metadata_json_check",
      sql`${table.metadata} IS NULL OR json_valid(${table.metadata})`,
    ),
    check("space_audit_events_metadata_length_check", optionalTextLength(table.metadata, JSON_TEXT_MAX_LENGTH)),
  ],
);

export type Space = typeof spaces.$inferSelect;
export type SpaceMember = typeof spaceMembers.$inferSelect;
export type SpaceInvite = typeof spaceInvites.$inferSelect;
export type SpaceAuditEvent = typeof spaceAuditEvents.$inferSelect;
