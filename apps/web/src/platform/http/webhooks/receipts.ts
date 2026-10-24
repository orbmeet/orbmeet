import type { Database } from "@orbmeet/db";
import { webhookEventReceipts } from "@orbmeet/db/schema";
import { and, eq, isNull, sql } from "drizzle-orm";
import { getRunChanges, withD1Retry } from "@/platform/database/db-utils";

/**
 * Idempotent at-least-once webhook delivery, shared by every provider
 * (LiveKit, Paddle, …). A receipt row is the dedup + processing-lease record:
 *
 *   reserve → (process) → markProcessed   on success
 *   reserve → (process) → release         on failure, so a redelivery retries
 *
 * `reserve` claims the receipt by inserting it; a concurrent or redelivered
 * event either sees it already processed (skip) or, if a prior attempt crashed
 * mid-flight, reclaims the lease once it expires. Receipt id is
 * `${provider}:${eventId}` so ids are unique per provider.
 */

const DEFAULT_LEASE_MS = 5 * 60 * 1000;
const RECEIPT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const RECEIPT_CLEANUP_BATCH_LIMIT = 500;

/**
 * Remove completed deduplication receipts only after a long redelivery window.
 * The bounded batch keeps daily maintenance predictable while repeated runs
 * naturally drain an existing backlog.
 */
export async function cleanupProcessedWebhookReceipts(
  db: Database,
  now = new Date(),
): Promise<number> {
  const cutoffSeconds = Math.floor((now.getTime() - RECEIPT_RETENTION_MS) / 1000);
  const result = await withD1Retry(
    () => db.run(sql`
      delete from ${webhookEventReceipts}
      where ${webhookEventReceipts.id} in (
        select ${webhookEventReceipts.id}
        from ${webhookEventReceipts}
        where ${webhookEventReceipts.processedAt} is not null
          and ${webhookEventReceipts.processedAt} < ${cutoffSeconds}
        order by ${webhookEventReceipts.processedAt}, ${webhookEventReceipts.id}
        limit ${RECEIPT_CLEANUP_BATCH_LIMIT}
      )
    `),
    { idempotent: true },
  );
  return getRunChanges(result);
}

export function buildReceiptId(provider: string, eventId: string): string {
  return `${provider}:${eventId}`;
}

export interface ReserveWebhookReceiptInput {
  provider: string;
  eventId: string;
  eventType: string;
  eventCreatedAt?: Date | null;
  now?: Date;
  leaseMs?: number;
  /** Stable across an insert retry; exposed to make ambiguous-commit recovery testable. */
  ownerToken?: string;
}

export type ReserveWebhookReceiptResult =
  | {
      status: "acquired";
      receiptId: string;
      leaseExpiresAt: Date;
      attemptCount: number;
      ownerToken: string;
    }
  | { status: "processed" }
  | { status: "in_progress"; retryAfterSeconds: number };

/**
 * Claim a processing lease for an event. An active lease is distinct from an
 * already processed event so webhook endpoints can ask the provider to retry
 * instead of acknowledging work that has not completed.
 */
export async function reserveWebhookReceipt(
  db: Database,
  input: ReserveWebhookReceiptInput,
): Promise<ReserveWebhookReceiptResult> {
  const now = input.now ?? new Date();
  const leaseSeconds = Math.ceil((input.leaseMs ?? DEFAULT_LEASE_MS) / 1000);
  const receiptId = buildReceiptId(input.provider, input.eventId);
  const ownerToken = input.ownerToken ?? crypto.randomUUID();
  // Every lease timestamp — written and compared — lives in D1's clock domain.
  // Writing `Worker now + 5 minutes` and expiring against `unixepoch()` put the
  // two ends of one lease in different clocks: with the Worker even slightly
  // more than the lease behind D1, a lease was already expired the instant it
  // was written, and two callers acquired the same receipt.
  const leaseExpiresAtSql = sql`(unixepoch() + ${leaseSeconds})`;

  const inserted = await withD1Retry(
    () =>
      db
        .insert(webhookEventReceipts)
        .values({
          id: receiptId,
          provider: input.provider,
          eventId: input.eventId,
          eventType: input.eventType,
          eventCreatedAt: input.eventCreatedAt ?? null,
          receivedAt: now,
          processedAt: null,
          processingStartedAt: sql`unixepoch()`,
          processingLeaseExpiresAt: leaseExpiresAtSql,
          processingOwnerToken: ownerToken,
          attemptCount: 1,
        })
        .onConflictDoNothing()
        .returning({ leaseExpiresAt: webhookEventReceipts.processingLeaseExpiresAt }),
    { idempotent: true },
  );
  const insertedLeaseExpiresAt = inserted[0]?.leaseExpiresAt;
  if (insertedLeaseExpiresAt) {
    return {
      status: "acquired",
      receiptId,
      leaseExpiresAt: insertedLeaseExpiresAt,
      attemptCount: 1,
      ownerToken,
    };
  }

  // Read the row and D1's clock together, so "is this lease still live?" is
  // answered entirely inside the domain the lease was written in.
  const [existing] = await db
    .select({
      processedAt: webhookEventReceipts.processedAt,
      processingLeaseExpiresAt: webhookEventReceipts.processingLeaseExpiresAt,
      processingOwnerToken: webhookEventReceipts.processingOwnerToken,
      attemptCount: webhookEventReceipts.attemptCount,
      databaseNowSeconds: sql<number>`unixepoch()`,
    })
    .from(webhookEventReceipts)
    .where(eq(webhookEventReceipts.id, receiptId))
    .limit(1);
  if (!existing) return { status: "in_progress", retryAfterSeconds: 1 };
  if (existing.processedAt) return { status: "processed" };

  const databaseNow = new Date(existing.databaseNowSeconds * 1000);
  const leaseIsLive = Boolean(
    existing.processingLeaseExpiresAt && existing.processingLeaseExpiresAt > databaseNow,
  );
  // An insert may have committed even if D1's response was lost. The retry's
  // conflict is our own active lease when its stable owner token matches.
  if (existing.processingOwnerToken === ownerToken && leaseIsLive) {
    return {
      status: "acquired",
      receiptId,
      leaseExpiresAt: existing.processingLeaseExpiresAt!,
      attemptCount: existing.attemptCount,
      ownerToken,
    };
  }
  if (leaseIsLive) {
    return {
      status: "in_progress",
      retryAfterSeconds: Math.max(
        1,
        Math.ceil(
          (existing.processingLeaseExpiresAt!.getTime() - databaseNow.getTime()) / 1000,
        ),
      ),
    };
  }

  const reclaimed = await db
      .update(webhookEventReceipts)
      .set({
        eventType: input.eventType,
        eventCreatedAt: input.eventCreatedAt ?? null,
        processingStartedAt: sql`unixepoch()`,
        processingLeaseExpiresAt: leaseExpiresAtSql,
        processingOwnerToken: ownerToken,
        attemptCount: sql`${webhookEventReceipts.attemptCount} + 1`,
      })
      .where(sql`
        ${webhookEventReceipts.id} = ${receiptId}
        and ${webhookEventReceipts.processedAt} is null
        and (
          ${webhookEventReceipts.processingLeaseExpiresAt} is null
          or ${webhookEventReceipts.processingLeaseExpiresAt} < unixepoch()
        )
      `)
      .returning({
        leaseExpiresAt: webhookEventReceipts.processingLeaseExpiresAt,
        attemptCount: webhookEventReceipts.attemptCount,
    });

  const reclaimedRow = reclaimed[0];
  if (reclaimedRow?.leaseExpiresAt) {
    return {
      status: "acquired",
      receiptId,
      leaseExpiresAt: reclaimedRow.leaseExpiresAt,
      attemptCount: reclaimedRow.attemptCount,
      ownerToken,
    };
  }

  // The reclaim can also commit before D1 loses its response. Its retry then
  // fails the expired-lease predicate, so recover ownership from the token.
  const [postReclaim] = await db
    .select({
      processedAt: webhookEventReceipts.processedAt,
      processingLeaseExpiresAt: webhookEventReceipts.processingLeaseExpiresAt,
      processingOwnerToken: webhookEventReceipts.processingOwnerToken,
      attemptCount: webhookEventReceipts.attemptCount,
      databaseNowSeconds: sql<number>`unixepoch()`,
    })
    .from(webhookEventReceipts)
    .where(eq(webhookEventReceipts.id, receiptId))
    .limit(1);
  if (
    postReclaim
    && !postReclaim.processedAt
    && postReclaim.processingOwnerToken === ownerToken
    && postReclaim.processingLeaseExpiresAt
    && postReclaim.processingLeaseExpiresAt > new Date(postReclaim.databaseNowSeconds * 1000)
  ) {
    return {
      status: "acquired",
      receiptId,
      leaseExpiresAt: postReclaim.processingLeaseExpiresAt,
      attemptCount: postReclaim.attemptCount,
      ownerToken,
    };
  }
  return { status: "in_progress", retryAfterSeconds: 1 };
}

export interface WebhookReceiptClaim {
  receiptId: string;
  leaseExpiresAt: Date;
  attemptCount: number;
  ownerToken: string;
}

export async function markWebhookReceiptProcessed(
  db: Database,
  claim: WebhookReceiptClaim,
): Promise<boolean> {
  const result = await withD1Retry(
    () =>
      db
        .update(webhookEventReceipts)
        .set({ processedAt: new Date(), processingLeaseExpiresAt: null })
        .where(and(
          eq(webhookEventReceipts.id, claim.receiptId),
          isNull(webhookEventReceipts.processedAt),
          eq(webhookEventReceipts.processingLeaseExpiresAt, claim.leaseExpiresAt),
          eq(webhookEventReceipts.attemptCount, claim.attemptCount),
          eq(webhookEventReceipts.processingOwnerToken, claim.ownerToken),
        )),
    { idempotent: true },
  );
  if (getRunChanges(result) > 0) return true;

  // The conditional update may have committed even when D1's response was
  // lost; an idempotent retry then reports zero changes. Confirm that this
  // exact fenced attempt is already complete instead of telling the endpoint
  // to fail a webhook whose work was durably acknowledged.
  const existing = await db.query.webhookEventReceipts.findFirst({
    where: { id: claim.receiptId },
    columns: { attemptCount: true, processedAt: true, processingOwnerToken: true },
  });
  return existing?.attemptCount === claim.attemptCount
    && existing.processingOwnerToken === claim.ownerToken
    && existing.processedAt !== null;
}

export async function releaseWebhookReceipt(
  db: Database,
  claim: WebhookReceiptClaim,
): Promise<boolean> {
  const result = await withD1Retry(
    () =>
      db
        .update(webhookEventReceipts)
        .set({
          processingStartedAt: null,
          processingLeaseExpiresAt: null,
        })
        .where(and(
          eq(webhookEventReceipts.id, claim.receiptId),
          isNull(webhookEventReceipts.processedAt),
          eq(webhookEventReceipts.processingLeaseExpiresAt, claim.leaseExpiresAt),
          eq(webhookEventReceipts.attemptCount, claim.attemptCount),
          eq(webhookEventReceipts.processingOwnerToken, claim.ownerToken),
        )),
    { idempotent: true },
  );
  return getRunChanges(result) > 0;
}
