import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { USER_CONTACT_SOURCES as USER_CONTACT_SOURCE_VALUES } from "@orbmeet/domain-model";
import { oneOf, optionalTextLength, requiredTrimmedTextLength } from "./columns.ts";
import { users } from "./identity.ts";
import { meetings } from "./meetings.ts";

// ============================================================================
// CONTACTS
// ============================================================================

/**
 * Private address book materialized from meetings and explicit invitations.
 * Meeting-derived contacts are opaque Orb Meet identities: email is populated
 * only when the owner supplied the address directly.
 */

export const userContacts = sqliteTable(
  "user_contacts",
  {
    id: text("id").notNull().primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    contactUserId: text("contact_user_id").references(() => users.id, {
      // Opaque contacts have no fallback email identity. Deleting the target
      // account must remove the contact rather than leave an invalid shell.
      onDelete: "cascade",
    }),
    email: text("email"),
    normalizedEmail: text("normalized_email"),
    displayName: text("display_name").notNull(),
    source: text("source", { enum: USER_CONTACT_SOURCE_VALUES }).notNull(),
    firstMetAt: integer("first_met_at", { mode: "timestamp" }),
    lastMetAt: integer("last_met_at", { mode: "timestamp" }),
    meetingCount: integer("meeting_count").notNull().default(0),
    lastMeetingId: text("last_meeting_id").references(() => meetings.id, {
      onDelete: "set null",
    }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date())
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("user_contacts_owner_email_unique_idx").on(
      table.ownerUserId,
      table.normalizedEmail,
    ),
    uniqueIndex("user_contacts_owner_user_unique_idx").on(
      table.ownerUserId,
      table.contactUserId,
    ),
    index("user_contacts_owner_name_idx").on(table.ownerUserId, table.displayName),
    index("user_contacts_contact_user_id_idx").on(table.contactUserId),
    index("user_contacts_last_meeting_id_idx").on(table.lastMeetingId),
    check("user_contacts_email_length_check", optionalTextLength(table.email, 320)),
    check(
      "user_contacts_normalized_email_length_check",
      optionalTextLength(table.normalizedEmail, 320),
    ),
    check(
      "user_contacts_identity_check",
      sql`${table.contactUserId} IS NOT NULL OR ${table.normalizedEmail} IS NOT NULL`,
    ),
    check("user_contacts_display_name_length_check", requiredTrimmedTextLength(table.displayName, 100)),
    check("user_contacts_source_check", oneOf(table.source, USER_CONTACT_SOURCE_VALUES)),
    check("user_contacts_meeting_count_check", sql`${table.meetingCount} >= 0`),
    check(
      "user_contacts_meeting_time_shape_check",
      sql`(
        (${table.firstMetAt} IS NULL AND ${table.lastMetAt} IS NULL AND ${table.meetingCount} = 0)
        OR (
          ${table.firstMetAt} IS NOT NULL
          AND ${table.lastMetAt} IS NOT NULL
          AND ${table.meetingCount} > 0
          AND ${table.lastMetAt} >= ${table.firstMetAt}
        )
      )`,
    ),
    check("user_contacts_updated_after_created_check", sql`${table.updatedAt} >= ${table.createdAt}`),
  ],
);

export type UserContact = typeof userContacts.$inferSelect;
