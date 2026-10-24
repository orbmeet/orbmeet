import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import {
  ORGANIZATION_MEMBER_ROLES as ORGANIZATION_ROLE_VALUES,
  SUBSCRIPTION_STATUSES as SUBSCRIPTION_STATUS_VALUES,
  SUBSCRIPTION_TIERS as SUBSCRIPTION_TIER_VALUES,
} from "@orbmeet/domain-model";
import { billingEventTimestamp, oneOf, requiredTrimmedTextLength } from "./columns.ts";
import { users } from "./identity.ts";

// ============================================================================
// ORGANIZATIONS
// ============================================================================

/**
 * A payer with seats. Its owner is the billing authority; a seat makes a
 * person eligible to join the Organization's Spaces but grants no access to
 * their content by itself.
 */
export const organizations = sqliteTable(
  "organizations",
  {
    id: text("id").notNull().primaryKey(),
    name: text("name").notNull(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    plan: text("plan", { enum: SUBSCRIPTION_TIER_VALUES })
      .default("organization")
      .notNull(),
    paddleCustomerId: text("paddle_customer_id"),
    paddleSubscriptionId: text("paddle_subscription_id"),
    subscriptionStatus: text("subscription_status", { enum: SUBSCRIPTION_STATUS_VALUES }),
    subscriptionUpdatedAt: billingEventTimestamp("subscription_updated_at"),
    licenseLimit: integer("license_limit").default(25).notNull(),
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
    uniqueIndex("organizations_owner_id_idx").on(table.ownerId),
    uniqueIndex("organizations_paddle_customer_id_idx").on(table.paddleCustomerId),
    uniqueIndex("organizations_paddle_subscription_id_idx").on(table.paddleSubscriptionId),
    check("organizations_name_length_check", requiredTrimmedTextLength(table.name, 200)),
    check("organizations_plan_check", oneOf(table.plan, SUBSCRIPTION_TIER_VALUES)),
    check(
      "organizations_subscription_status_check",
      sql`${table.subscriptionStatus} IS NULL OR ${oneOf(table.subscriptionStatus, SUBSCRIPTION_STATUS_VALUES)}`,
    ),
    check("organizations_license_limit_positive_check", sql`${table.licenseLimit} > 0`),
    check("organizations_updated_after_created_check", sql`${table.updatedAt} >= ${table.createdAt}`),
    check(
      "organizations_archived_after_created_check",
      sql`${table.archivedAt} IS NULL OR ${table.archivedAt} >= ${table.createdAt}`,
    ),
  ],
);

/**
 * A seat in an Organization, with delegated authority (`admin` or `member`).
 * Ownership is on the organization row, never here.
 */
export const organizationMembers = sqliteTable(
  "organization_members",
  {
    id: text("id").notNull().primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role", { enum: ORGANIZATION_ROLE_VALUES })
      .default("member")
      .notNull(),
    joinedAt: integer("joined_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index("organization_members_user_id_idx").on(table.userId),
    uniqueIndex("organization_members_unique_idx").on(table.organizationId, table.userId),
    check("organization_members_role_check", oneOf(table.role, ORGANIZATION_ROLE_VALUES)),
  ],
);

/**
 * A billing-bearing ownership transfer must be accepted by the proposed
 * owner. One pending nomination per Organization keeps replacement and
 * cancellation deterministic.
 */

export const organizationOwnershipTransfers = sqliteTable(
  "organization_ownership_transfers",
  {
    organizationId: text("organization_id")
      .notNull()
      .primaryKey()
      .references(() => organizations.id, { onDelete: "cascade" }),
    requestedByUserId: text("requested_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    proposedOwnerUserId: text("proposed_owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date())
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("organization_ownership_transfers_requested_by_idx")
      .on(table.requestedByUserId),
    index("organization_ownership_transfers_proposed_owner_idx")
      .on(table.proposedOwnerUserId, table.expiresAt),
    index("organization_ownership_transfers_expires_at_idx").on(table.expiresAt),
    check(
      "organization_ownership_transfers_distinct_users_check",
      sql`${table.requestedByUserId} <> ${table.proposedOwnerUserId}`,
    ),
    check(
      "organization_ownership_transfers_expires_after_created_check",
      sql`${table.expiresAt} >= ${table.createdAt}`,
    ),
    check(
      "organization_ownership_transfers_updated_after_created_check",
      sql`${table.updatedAt} >= ${table.createdAt}`,
    ),
  ],
);

export type Organization = typeof organizations.$inferSelect;
export type OrganizationMember = typeof organizationMembers.$inferSelect;
