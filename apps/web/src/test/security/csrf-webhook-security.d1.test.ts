import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type TestDb } from "@/test/db";
import { webhookEventReceipts } from "@orbmeet/db/schema";
import { eq, sql } from "drizzle-orm";
import {
  reserveWebhookReceipt,
  buildReceiptId,
} from "@/platform/http/webhooks/receipts";

let db: TestDb;

beforeEach(async () => {
  db = await createTestDb();
});

describe("Empirical Webhook Receipt Deduplication & Replay Protection Verification", () => {
  const provider = "livekit";
  const eventId = "evt_security_audit_001";
  const eventType = "participant_joined";

  it("acquires lease on initial webhook receipt", async () => {
    const now = new Date();
    const result = await reserveWebhookReceipt(db, {
      provider,
      eventId,
      eventType,
      now,
    });

    expect(result.status).toBe("acquired");
    const acquired = result as Extract<typeof result, { status: "acquired" }>;
    expect(acquired.receiptId).toBe(buildReceiptId(provider, eventId));
    expect(acquired.attemptCount).toBe(1);
    expect(acquired.ownerToken).toBeDefined();

    const row = await db.query.webhookEventReceipts.findFirst({
      where: { id: buildReceiptId(provider, eventId) },
    });
    expect(row).toBeDefined();
    expect(row?.provider).toBe(provider);
    expect(row?.eventId).toBe(eventId);
    expect(row?.processedAt).toBeNull();
  });

  it("reports in_progress when another worker delivers the same event while lease is active", async () => {
    const now = new Date();
    const firstAttempt = await reserveWebhookReceipt(db, {
      provider,
      eventId,
      eventType,
      now,
    });
    expect(firstAttempt.status).toBe("acquired");

    // Concurrent request from a different worker (different ownerToken)
    const concurrentAttempt = await reserveWebhookReceipt(db, {
      provider,
      eventId,
      eventType,
      now,
      ownerToken: "different_worker_token",
    });

    expect(concurrentAttempt.status).toBe("in_progress");
  });

  it("reclaims active lease if the original worker retries with the same stable ownerToken (ambiguous commit recovery)", async () => {
    const now = new Date();
    const stableOwnerToken = "stable_worker_token_123";

    const firstAttempt = await reserveWebhookReceipt(db, {
      provider,
      eventId,
      eventType,
      now,
      ownerToken: stableOwnerToken,
    });
    expect(firstAttempt.status).toBe("acquired");

    // Network hiccup retry: same worker sends same ownerToken
    const retryAttempt = await reserveWebhookReceipt(db, {
      provider,
      eventId,
      eventType,
      now,
      ownerToken: stableOwnerToken,
    });

    expect(retryAttempt.status).toBe("acquired");
    const reacquired = retryAttempt as Extract<typeof retryAttempt, { status: "acquired" }>;
    expect(reacquired.ownerToken).toBe(stableOwnerToken);
  });

  it("blocks replays and returns 'processed' after webhook work has committed", async () => {
    const now = new Date();
    const firstAttempt = await reserveWebhookReceipt(db, {
      provider,
      eventId,
      eventType,
      now,
    });
    expect(firstAttempt.status).toBe("acquired");

    // Worker completes webhook handling and marks receipt processed
    await db
      .update(webhookEventReceipts)
      .set({ processedAt: new Date() })
      .where(eq(webhookEventReceipts.id, buildReceiptId(provider, eventId)));

    // Replay delivery from webhook provider arrives
    const replayAttempt = await reserveWebhookReceipt(db, {
      provider,
      eventId,
      eventType,
      now: new Date(now.getTime() + 10_000),
    });

    expect(replayAttempt.status).toBe("processed");
  });

  it("allows lease reclamation by another worker when prior attempt expired without processing", async () => {
    // Both ends of a lease live in D1's clock now, so expiry cannot be staged
    // by handing `reserve` an old Worker `now` — that used to write a lease
    // that was already expired the instant it was created, which is the skew
    // bug itself. Age the stored lease instead, the way real time would.
    await reserveWebhookReceipt(db, {
      provider,
      eventId,
      eventType,
      leaseMs: 60_000,
      ownerToken: "worker_1_crashed",
    });
    await db
      .update(webhookEventReceipts)
      .set({ processingLeaseExpiresAt: sql`unixepoch() - 60` })
      .where(eq(webhookEventReceipts.id, buildReceiptId(provider, eventId)));

    const retryAfterExpiry = await reserveWebhookReceipt(db, {
      provider,
      eventId,
      eventType,
      ownerToken: "worker_2_pickup",
    });

    expect(retryAfterExpiry.status).toBe("acquired");
    const reacquired = retryAfterExpiry as Extract<typeof retryAfterExpiry, { status: "acquired" }>;
    expect(reacquired.attemptCount).toBe(2);
    expect(reacquired.ownerToken).toBe("worker_2_pickup");
  });

  it("refuses a second worker while the first worker's lease is live", async () => {
    // The lease write and the expiry check used to sit in different clocks:
    // `Worker now + lease` written, `unixepoch()` compared. A Worker clock more
    // than one lease behind D1 therefore handed two workers the same receipt.
    const laggingWorkerNow = new Date(Date.now() - 600_000);
    await reserveWebhookReceipt(db, {
      provider,
      eventId,
      eventType,
      now: laggingWorkerNow,
      ownerToken: "worker_1",
    });

    const contender = await reserveWebhookReceipt(db, {
      provider,
      eventId,
      eventType,
      now: laggingWorkerNow,
      ownerToken: "worker_2",
    });

    expect(contender.status).toBe("in_progress");
  });
});
