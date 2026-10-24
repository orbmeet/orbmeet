import { beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { webhookEventReceipts } from "@orbmeet/db/schema";
import { createTestDb, type TestDb } from "@/test/db";
import {
  cleanupProcessedWebhookReceipts,
  markWebhookReceiptProcessed,
  releaseWebhookReceipt,
  reserveWebhookReceipt,
} from "./receipts";

let db: TestDb;
const appDb = () => db;

beforeEach(async () => {
  db = await createTestDb();
});

describe("webhook receipt claim fencing", () => {
  it("recognizes its own lease after an ambiguous insert commit", async () => {
    const ownerToken = "retry-owner-token";

    // Model D1 committing the first insert while its response is lost. The
    // retry reaches ON CONFLICT, then must recover this exact ownership claim.
    // The lease is written in D1's clock, the way `reserve` writes it.
    const [seeded] = await db.insert(webhookEventReceipts).values({
      id: "test:event-ambiguous",
      provider: "test",
      eventId: "event-ambiguous",
      eventType: "changed",
      receivedAt: new Date(),
      processingStartedAt: sql`unixepoch()`,
      processingLeaseExpiresAt: sql`(unixepoch() + 30)`,
      processingOwnerToken: ownerToken,
      attemptCount: 1,
    }).returning({ leaseExpiresAt: webhookEventReceipts.processingLeaseExpiresAt });

    const reservation = await reserveWebhookReceipt(appDb(), {
      provider: "test",
      eventId: "event-ambiguous",
      eventType: "changed",
      leaseMs: 30_000,
      ownerToken,
    });

    expect(reservation).toMatchObject({
      status: "acquired",
      attemptCount: 1,
      leaseExpiresAt: seeded.leaseExpiresAt,
      ownerToken,
    });
    if (reservation.status !== "acquired") throw new Error("expected recovered claim");
    expect(await markWebhookReceiptProcessed(appDb(), reservation)).toBe(true);
  });

  it("keeps a fresh lease exclusive when the Worker clock lags D1's", async () => {
    // The lease used to be written as `Worker now + 5 minutes` and expired
    // against D1's `unixepoch()`. A Worker clock more than the lease behind D1
    // therefore wrote a lease that was already expired, and the very next
    // caller reclaimed a receipt someone else was actively processing.
    const laggingWorkerNow = new Date(Date.now() - 301_000);

    const first = await reserveWebhookReceipt(appDb(), {
      provider: "test",
      eventId: "event-skew",
      eventType: "changed",
      now: laggingWorkerNow,
    });
    expect(first.status).toBe("acquired");

    const second = await reserveWebhookReceipt(appDb(), {
      provider: "test",
      eventId: "event-skew",
      eventType: "changed",
      now: laggingWorkerNow,
    });
    expect(second).toMatchObject({ status: "in_progress" });
    if (second.status !== "in_progress") throw new Error("expected contention");
    expect(second.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("does not let an old claim release or complete a newer attempt", async () => {
    const now = new Date("2026-07-28T12:00:00.000Z");
    const first = await reserveWebhookReceipt(appDb(), {
      provider: "test",
      eventId: "event-1",
      eventType: "changed",
      now,
      leaseMs: 30_000,
    });
    expect(first.status).toBe("acquired");
    if (first.status !== "acquired") throw new Error("expected first claim");

    expect(await releaseWebhookReceipt(appDb(), first)).toBe(true);

    // Reacquire at the same clock instant. The stored expiry is deliberately
    // identical, proving the attempt number—not timestamp uniqueness—fences it.
    const second = await reserveWebhookReceipt(appDb(), {
      provider: "test",
      eventId: "event-1",
      eventType: "changed",
      now,
      leaseMs: 30_000,
    });
    expect(second).toMatchObject({ status: "acquired", attemptCount: 2 });
    if (second.status !== "acquired") throw new Error("expected second claim");

    expect(await releaseWebhookReceipt(appDb(), first)).toBe(false);
    expect(await markWebhookReceiptProcessed(appDb(), first)).toBe(false);
    expect(await markWebhookReceiptProcessed(appDb(), second)).toBe(true);
    expect(await markWebhookReceiptProcessed(appDb(), second)).toBe(true);

    await expect(db.query.webhookEventReceipts.findFirst({
      where: { id: "test:event-1" },
    })).resolves.toMatchObject({
      attemptCount: 2,
      processedAt: expect.any(Date),
    });
  });
});

describe("webhook receipt retention", () => {
  it("prunes only completed receipts beyond the redelivery window", async () => {
    const oldReceivedAt = new Date("2026-01-01T00:00:00.000Z");
    await db.insert(webhookEventReceipts).values([
      {
        id: "test:old-complete", provider: "test", eventId: "old-complete",
        eventType: "changed", receivedAt: oldReceivedAt,
        processedAt: new Date("2026-05-01T00:00:00.000Z"), attemptCount: 1,
      },
      {
        id: "test:recent-complete", provider: "test", eventId: "recent-complete",
        eventType: "changed", receivedAt: oldReceivedAt,
        processedAt: new Date("2026-08-01T00:00:00.000Z"), attemptCount: 1,
      },
      {
        id: "test:old-incomplete", provider: "test", eventId: "old-incomplete",
        eventType: "changed", receivedAt: oldReceivedAt, attemptCount: 1,
      },
    ]);

    await expect(cleanupProcessedWebhookReceipts(
      appDb(),
      new Date("2026-08-22T00:00:00.000Z"),
    )).resolves.toBe(1);
    await expect(db.select({ id: webhookEventReceipts.id }).from(webhookEventReceipts))
      .resolves.toEqual(expect.arrayContaining([
        { id: "test:recent-complete" },
        { id: "test:old-incomplete" },
      ]));
  });
});
