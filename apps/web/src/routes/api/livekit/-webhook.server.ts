import "@tanstack/react-start/server-only";
import { WebhookReceiver } from "livekit-server-sdk";
import type { WebhookEvent } from "livekit-server-sdk";
import { getOptionalEnv } from "@/platform/runtime/server-runtime.server";
import {
  enforceWebhookPreAuthRateLimit,
  rateLimitErrorResponse,
} from "@/platform/http/rate-limit.server";
import { mediaNodeKey, type MediaNode } from "@/platform/realtime/nodes";
import { liveKitMeetingRoomName } from "@/modules/meetings/contract/livekit-room";
import { closeDrainedMeetingRooms } from "@/modules/meetings/server/room/media-placement.server";
import { createDb } from "@orbmeet/db";
import { logError, logInfo } from "@/lib/logger";
import { addLogContext } from "@/platform/runtime/log-context";
import { RequestBodyTooLargeError, readRequestBodyText } from "@/platform/http/request-body";
import { callCoordinator } from "@/modules/meetings/server/runtime/client.server";
import { observationFor } from "@/modules/meetings/server/runtime/livekit-observations.server";
import type { Observation } from "@/modules/meetings/server/runtime/protocol";

const MAX_LIVEKIT_WEBHOOK_BODY_BYTES = 1024 * 1024;

/**
 * The key a webhook claims to be signed with, read from the token's `iss`
 * before verification, with the node that holds it. `WebhookReceiver` then
 * verifies against that key's secret, so an unverified claim only selects
 * which key must match.
 */
function webhookSigningKey(
  env: Env,
  authHeader: string | undefined,
): { keyId: string; secret: string; node: MediaNode } | null {
  const payload = authHeader?.replace(/^Bearer\s+/i, "").split(".")[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(
      atob(payload.replace(/-/g, "+").replace(/_/g, "/")),
    ) as { iss?: unknown };
    if (typeof claims.iss !== "string") return null;
    const key = mediaNodeKey(env, claims.iss);
    return key ? { keyId: claims.iss, ...key } : null;
  } catch {
    return null;
  }
}

/**
 * LiveKit webhooks are hints, not the source of truth: delivery is not
 * guaranteed, so each one only tells the meeting's coordinator to look sooner.
 * Every observation is idempotent there, which is why redeliveries need no
 * receipt table.
 */
export async function handleLivekitWebhookRequest(request: Request): Promise<Response> {
  const env = await getOptionalEnv();
  if (!env?.NODES) {
    return new Response("Service unavailable", { status: 503 });
  }
  try {
    await enforceWebhookPreAuthRateLimit(env, "livekit");
  } catch (error) {
    return rateLimitErrorResponse(error, "livekit-webhook-pre-auth");
  }

  let body: string;
  try {
    body = await readRequestBodyText(request, MAX_LIVEKIT_WEBHOOK_BODY_BYTES);
  } catch (err) {
    if (err instanceof RequestBodyTooLargeError) {
      return new Response("Payload too large", { status: 413 });
    }
    throw err;
  }
  const authHeader = request.headers.get("Authorization") ?? undefined;

  const key = webhookSigningKey(env, authHeader);
  if (!key) return new Response("Unauthorized", { status: 401 });
  let event: WebhookEvent;
  try {
    event = await new WebhookReceiver(key.keyId, key.secret).receive(body, authHeader);
  } catch {
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    await forwardLivekitWebhookEvent(event, key.node, env);
  } catch (err) {
    logError("[webhook] Unhandled error:", err);
    return new Response("Webhook processing failed", { status: 500 });
  }
  return new Response("OK", { status: 200 });
}

export async function forwardLivekitWebhookEvent(event: WebhookEvent, node: MediaNode, env: Env): Promise<void> {
  const forwarded = observationFor(event);
  if (!forwarded) return;
  addLogContext({ meetingId: forwarded.meetingId });
  logParticipantEvent(event, forwarded.observation, node);
  try {
    await callCoordinator(env, {
      kind: "observe",
      meetingId: forwarded.meetingId,
      nodeId: node.id,
      observation: forwarded.observation,
    });
  } catch (error) {
    // An event about a meeting that is over, or never existed, is not a failure.
    const code = (error as { code?: unknown } | null)?.code;
    if (code !== "MEETING_ENDED" && code !== "NOT_FOUND") throw error;
    // But a room that starts, or gains a participant, after its Meeting is
    // over was recreated by a cached token, and its coordinator will not close
    // it. Close it on the node that reported it; the minutely node check is
    // the backstop when this delivery is lost.
    const { kind } = forwarded.observation;
    if (kind === "participantJoined" || kind === "roomStarted") {
      await closeDrainedMeetingRooms(createDb(env.DB), node, [liveKitMeetingRoomName(forwarded.meetingId)]);
    }
  }
}

/**
 * A participant's join or departure, with LiveKit's reason for a departure:
 * the meeting's timeline in the Worker's own log, beside what the node ships.
 */
function logParticipantEvent(event: WebhookEvent, observation: Observation, node: MediaNode): void {
  if (observation.kind !== "participantJoined" && observation.kind !== "participantLeft") return;
  // Protobuf's JSON form names the enum, and leaves it out when unknown.
  const { disconnectReason } = event.participant?.toJson() as { disconnectReason?: string } | undefined ?? {};
  logInfo(`[livekit] ${event.event}`, {
    node: node.id,
    identity: observation.identity,
    sid: observation.sid,
    ...(observation.kind === "participantLeft" ? { reason: disconnectReason ?? "UNKNOWN_REASON" } : {}),
  });
}
