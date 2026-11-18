import "@tanstack/react-start/server-only";

import { createDb } from "@orbmeet/db";
import { logError, logWarn } from "@/lib/logger";
import { enforceWebhookPreAuthRateLimit, rateLimitErrorResponse } from "@/platform/http/rate-limit.server";
import { RequestBodyTooLargeError, readRequestBodyText } from "@/platform/http/request-body";
import {
  markWebhookReceiptProcessed,
  releaseWebhookReceipt,
  reserveWebhookReceipt,
} from "@/platform/http/webhooks/receipts";
import { getOptionalEnv } from "@/platform/runtime/server-runtime.server";
import { parsePolarWebhookEvent } from "./polar-schema";
import { verifyPolarWebhookSignature } from "./polar-signature";
import { syncSubscription } from "./subscription-store.server";

const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;

/**
 * Polar's webhook: pre-auth rate limit, body cap, signature, then the
 * subscription snapshot is stored behind a dedup/lease receipt keyed by the
 * `webhook-id` header, which Polar keeps across redeliveries.
 *
 * Processing is synchronous: a failure answers 500 so Polar redelivers
 * (at-least-once), and the receipt makes a repeat a no-op. Storing is
 * order-independent, so no serial scope is needed.
 */
export async function handleBillingWebhookRequest(request: Request): Promise<Response> {
  const env = await getOptionalEnv();
  if (!env?.POLAR_WEBHOOK_SECRET) return new Response("Service unavailable", { status: 503 });
  try {
    await enforceWebhookPreAuthRateLimit(env, "polar");
  } catch (error) {
    return rateLimitErrorResponse(error, "polar-webhook-pre-auth");
  }

  let body: string;
  try {
    body = await readRequestBodyText(request, MAX_WEBHOOK_BODY_BYTES);
  } catch (err) {
    if (err instanceof RequestBodyTooLargeError) return new Response("Payload too large", { status: 413 });
    throw err;
  }
  const webhookId = request.headers.get("webhook-id") ?? "";
  const webhookTimestamp = request.headers.get("webhook-timestamp") ?? "";
  const valid = await verifyPolarWebhookSignature(
    body,
    { id: webhookId, timestamp: webhookTimestamp, signature: request.headers.get("webhook-signature") ?? "" },
    env.POLAR_WEBHOOK_SECRET,
  ).catch(() => false);
  if (!valid) {
    logWarn("[billing-webhook] Invalid signature");
    return new Response("Unauthorized", { status: 401 });
  }

  // Past the signature the event is Polar's. One this build cannot read is
  // acknowledged rather than refused: a redelivery carries the same bytes and
  // reads no better, and refusing would keep Polar retrying and mark the
  // endpoint unhealthy. The daily reconciliation reads the subscription from
  // Polar's API, so its state still lands; the error says it was late.
  let parsedBody: unknown = null;
  try {
    parsedBody = JSON.parse(body) as unknown;
  } catch {
    // Read as unreadable below.
  }
  const event = parsePolarWebhookEvent(parsedBody);
  if (event.kind === "unreadable") {
    logError("[billing-webhook] Acknowledged a signed event this build cannot read", {
      webhookId,
      eventType: event.eventType,
    });
    return new Response("OK", { status: 200 });
  }
  if (event.kind === "ignored") return new Response("OK", { status: 200 });

  const db = createDb(env.DB);
  const reservation = await reserveWebhookReceipt(db, {
    provider: "polar",
    eventId: webhookId,
    eventType: event.eventType,
    eventCreatedAt: new Date(Number.parseInt(webhookTimestamp, 10) * 1000),
  });
  if (reservation.status === "processed") return new Response("OK", { status: 200 });
  if (reservation.status === "in_progress") {
    return new Response("Webhook processing in progress", {
      status: 503,
      headers: { "Retry-After": String(reservation.retryAfterSeconds) },
    });
  }
  const claim = {
    receiptId: reservation.receiptId,
    leaseExpiresAt: reservation.leaseExpiresAt,
    attemptCount: reservation.attemptCount,
    ownerToken: reservation.ownerToken,
  };

  try {
    await syncSubscription(db, env, event.subscription);
    if (!(await markWebhookReceiptProcessed(db, claim))) {
      throw new Error("Polar webhook receipt lease expired before completion");
    }
  } catch (err) {
    logError("[billing-webhook] Unhandled error:", err);
    await releaseWebhookReceipt(db, claim).catch((releaseErr) => {
      logError("[billing-webhook] Failed to release failed webhook receipt:", releaseErr);
    });
    return new Response("Webhook processing failed", { status: 500 });
  }
  return new Response("OK", { status: 200 });
}
