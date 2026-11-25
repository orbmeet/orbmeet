import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { PAID_SUBSCRIPTION_TIERS, SUBSCRIPTION_STATUSES as SUBSCRIPTION_STATUS_VALUES } from "@orbmeet/domain-model";
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
 * Organization, which buys the seat-based Organization plan. `plan` is the plan
 * the subscription's product grants that customer, null for any product that
 * grants none (one the customer switched to in the provider's portal): a plan
 * is granted by status and product together, never by status alone.
 * `source_version` is the provider's own modification time in epoch
 * microseconds, its own precision, so a late or repeated read never
 * overwrites a newer one, however close together the two were made. One
 * writer: modules/billing/server/subscription-store.server.ts.
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
    plan: text("plan", { enum: PAID_SUBSCRIPTION_TIERS }),
    sourceVersion: integer("source_version").notNull(),
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
    check(
      "billing_subscriptions_plan_check",
      sql`${table.plan} IS NULL OR (${table.plan} = 'pro' AND ${table.userId} IS NOT NULL) OR (${table.plan} = 'organization' AND ${table.organizationId} IS NOT NULL)`,
    ),
  ],
);
