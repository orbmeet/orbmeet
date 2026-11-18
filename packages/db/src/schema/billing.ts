import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { SUBSCRIPTION_STATUSES as SUBSCRIPTION_STATUS_VALUES } from "@orbmeet/domain-model";
import { billingEventTimestamp, oneOf } from "./columns.ts";
import { users } from "./identity.ts";
import { organizations } from "./organizations.ts";

// ============================================================================
// BILLING
// ============================================================================

/**
 * The billing provider's subscriptions, as last read from it: the only source
 * of paid entitlements. A user's Pro plan, and an Organization's plan and
 * seats, are derived from these rows and stored nowhere else.
 *
 * Each row belongs to exactly one customer: a user, who can buy Pro, or an
 * Organization, which buys the seat-based Organization plan. `source_version`
 * is the provider's own modification time, so a late or repeated read never
 * overwrites a newer one. One writer: modules/billing/server/subscription-store.server.ts.
 */
export const billingSubscriptions = sqliteTable(
  "billing_subscriptions",
  {
    // The provider's subscription id.
    id: text("id").notNull().primaryKey(),
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    organizationId: text("organization_id").references(() => organizations.id, { onDelete: "cascade" }),
    status: text("status", { enum: SUBSCRIPTION_STATUS_VALUES }).notNull(),
    // Paid seats. Organization subscriptions only.
    seats: integer("seats"),
    cancelAtPeriodEnd: integer("cancel_at_period_end", { mode: "boolean" }).notNull(),
    currentPeriodEnd: billingEventTimestamp("current_period_end"),
    sourceVersion: billingEventTimestamp("source_version").notNull(),
  },
  (table) => [
    index("billing_subscriptions_user_idx").on(table.userId),
    index("billing_subscriptions_organization_idx").on(table.organizationId),
    check(
      "billing_subscriptions_one_customer_check",
      sql`(${table.userId} IS NULL) <> (${table.organizationId} IS NULL)`,
    ),
    check(
      "billing_subscriptions_seats_check",
      sql`(${table.organizationId} IS NULL AND ${table.seats} IS NULL) OR (${table.organizationId} IS NOT NULL AND ${table.seats} >= 1)`,
    ),
    check("billing_subscriptions_status_check", oneOf(table.status, SUBSCRIPTION_STATUS_VALUES)),
  ],
);
