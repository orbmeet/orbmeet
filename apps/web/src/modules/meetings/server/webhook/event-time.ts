import type { WebhookEvent } from "livekit-server-sdk";

/**
 * LiveKit declares webhook `createdAt` as an int64 and the server SDK decodes
 * it to bigint. Convert that wire value once, at the webhook boundary, and
 * reject the protobuf default (0) or values JavaScript cannot represent
 * exactly as epoch seconds.
 */
export function liveKitWebhookCreatedAt(event: Pick<WebhookEvent, "createdAt">): Date | null {
  const seconds = Number(event.createdAt);
  if (!Number.isSafeInteger(seconds) || seconds <= 0) return null;

  const milliseconds = seconds * 1_000;
  if (!Number.isSafeInteger(milliseconds)) return null;
  const createdAt = new Date(milliseconds);
  return Number.isFinite(createdAt.getTime()) ? createdAt : null;
}
