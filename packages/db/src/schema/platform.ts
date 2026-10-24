import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { EMAIL_SUPPRESSION_REASONS as EMAIL_SUPPRESSION_REASON_VALUES } from "@orbmeet/domain-model";
import { oneOf, optionalTextLength, requiredTrimmedTextLength } from "./columns.ts";

/** The services a node runs, each probed apart. */
export const NODE_SERVICES = ["media", "whiteboard"] as const;

// ============================================================================
// PLATFORM STATE
// ============================================================================
// Infrastructure state that belongs to no product domain: maintenance cursors
// and cleanup candidates, webhook receipts, node health
// and email suppressions. Background work itself runs as Workflow jobs
// (apps/web/src/platform/jobs), which keep their own progress.

/**
 * Whether each service of each self-hosted node answers the Worker's minutely
 * probe: media (LiveKit) and the whiteboard sync server, apart, so one
 * restarting moves only its own work.
 */
export const nodeHealth = sqliteTable(
  "node_health",
  {
    nodeId: text("node_id").notNull(),
    service: text("service", { enum: NODE_SERVICES }).notNull(),
    checkedAt: integer("checked_at", { mode: "timestamp" }).notNull(),
    // Probes failed in a row; 0 once one succeeds.
    failures: integer("failures").notNull(),
    // When the current run of failures began; null while the service answers.
    failingSince: integer("failing_since", { mode: "timestamp" }),
  },
  (table) => [
    primaryKey({ columns: [table.nodeId, table.service], name: "node_health_pk" }),
    check("node_health_node_id_length_check", requiredTrimmedTextLength(table.nodeId, 64)),
    check("node_health_service_check", oneOf(table.service, NODE_SERVICES)),
    check("node_health_failures_check", sql`${table.failures} >= 0`),
  ],
);

/**
 * Addresses this deployment must not mail again. Cloudflare Email Service keeps
 * the authoritative account-wide suppression list and rejects a suppressed
 * recipient with `E_RECIPIENT_SUPPRESSED`, but it exposes no read API, so a send
 * is the only way to discover the entry. This table is the local mirror: it lets
 * delivery skip a known-bad address instead of burning an attempt (and a hard
 * bounce against the <2% reputation target) to rediscover it every time.
 *
 * Rows arrive from two places: a rejected send records `bounced`/`complained`,
 * and the one-click List-Unsubscribe endpoint records `unsubscribed`.
 */

export const emailSuppressions = sqliteTable(
  "email_suppressions",
  {
    /** The normalized (lowercased, trimmed) address. Suppression is per address,
     * so it doubles as the primary key — there is nothing to suppress twice. */
    normalizedEmail: text("normalized_email").notNull().primaryKey(),
    reason: text("reason", { enum: EMAIL_SUPPRESSION_REASON_VALUES }).notNull(),
    /** Provider error code that produced the row, for `bounced`/`complained`. */
    providerCode: text("provider_code"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index("email_suppressions_created_idx").on(table.createdAt),
    check(
      "email_suppressions_normalized_email_length_check",
      sql`length(${table.normalizedEmail}) <= 320`,
    ),
    check(
      "email_suppressions_reason_check",
      oneOf(table.reason, EMAIL_SUPPRESSION_REASON_VALUES),
    ),
    check(
      "email_suppressions_provider_code_length_check",
      optionalTextLength(table.providerCode, 64),
    ),
  ],
);

/**
 * Where each resumable maintenance scan stopped, by job name. The position is
 * `cursor_id`; `cursor_at` is written only to satisfy the shape check. No row
 * means the next run starts from the beginning.
 */
export const maintenanceCursors = sqliteTable(
  "maintenance_cursors",
  {
    job: text("job").notNull().primaryKey(),
    cursorAt: integer("cursor_at", { mode: "timestamp" }),
    cursorId: text("cursor_id"),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date())
      .$onUpdate(() => new Date()),
  },
  (table) => [
    check("maintenance_cursors_job_length_check", requiredTrimmedTextLength(table.job, 100)),
    check(
      "maintenance_cursors_shape_check",
      sql`(${table.cursorAt} IS NULL AND ${table.cursorId} IS NULL) OR (${table.cursorAt} IS NOT NULL AND ${table.cursorId} IS NOT NULL)`,
    ),
  ],
);

/**
 * Durable cleanup queue for R2 keys whose last relational owner may disappear.
 * A row is also how a deletion is announced: `deleting_at` is set, in the same
 * statement that finds no row referencing the key, before the object is
 * deleted, and nothing may start referencing a key while it is set.
 */

export const r2ObjectCleanupTasks = sqliteTable(
  "r2_object_cleanup_tasks",
  {
    r2Key: text("r2_key").notNull().primaryKey(),
    notBefore: integer("not_before", { mode: "timestamp" }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    deletingAt: integer("deleting_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date())
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("r2_object_cleanup_tasks_due_idx").on(table.notBefore),
    check("r2_object_cleanup_tasks_key_check", sql`length(${table.r2Key}) between 1 and 1000`),
    check("r2_object_cleanup_tasks_attempts_check", sql`${table.attempts} >= 0`),
    check("r2_object_cleanup_tasks_error_check", optionalTextLength(table.lastError, 1000)),
  ],
);

/**
 * One row per provider event (LiveKit, Paddle, …): deduplicates redeliveries
 * and leases processing to one worker at a time, so a crashed attempt is
 * retried once its lease expires. See platform/http/webhooks/receipts.ts.
 */
export const webhookEventReceipts = sqliteTable(
  "webhook_event_receipts",
  {
    id: text("id").notNull().primaryKey(),
    provider: text("provider").notNull(),
    eventId: text("event_id").notNull(),
    eventType: text("event_type").notNull(),
    eventCreatedAt: integer("event_created_at", { mode: "timestamp" }),
    receivedAt: integer("received_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    processedAt: integer("processed_at", { mode: "timestamp" }),
    processingStartedAt: integer("processing_started_at", { mode: "timestamp" }),
    processingLeaseExpiresAt: integer("processing_lease_expires_at", { mode: "timestamp" }),
    processingOwnerToken: text("processing_owner_token"),
    attemptCount: integer("attempt_count").default(0).notNull(),
  },
  (table) => [
    uniqueIndex("webhook_event_receipts_provider_event_unique_idx").on(table.provider, table.eventId),
    index("webhook_event_receipts_provider_received_idx").on(table.provider, table.receivedAt),
    index("webhook_event_receipts_provider_lease_idx").on(table.provider, table.processedAt, table.processingLeaseExpiresAt),
    index("webhook_event_receipts_processed_idx").on(table.processedAt, table.id),
    check("webhook_event_receipts_provider_length_check", requiredTrimmedTextLength(table.provider, 64)),
    check("webhook_event_receipts_event_id_length_check", requiredTrimmedTextLength(table.eventId, 255)),
    check("webhook_event_receipts_event_type_length_check", requiredTrimmedTextLength(table.eventType, 100)),
    check(
      "webhook_event_receipts_owner_token_length_check",
      optionalTextLength(table.processingOwnerToken, 64),
    ),
    check(
      "webhook_event_receipts_processed_after_received_check",
      sql`${table.processedAt} IS NULL OR ${table.processedAt} >= ${table.receivedAt}`,
    ),
    check(
      "webhook_event_receipts_lease_after_started_check",
      sql`${table.processingLeaseExpiresAt} IS NULL OR ${table.processingStartedAt} IS NOT NULL`,
    ),
    check(
      "webhook_event_receipts_attempt_count_check",
      sql`${table.attemptCount} >= 0`,
    ),
  ],
);

export type EmailSuppression = typeof emailSuppressions.$inferSelect;
export type MaintenanceCursor = typeof maintenanceCursors.$inferSelect;
