import * as v from "valibot";
import "@tanstack/react-start/server-only";
import { createDb } from "@orbmeet/db";
import { getOptionalEnv } from "@/platform/runtime/server-runtime.server";
import { readSignedRequest } from "@/platform/http/internal-auth";
import { parseKeyring } from "@orbmeet/primitives";
import {
  enforceRateLimit,
  enforceTranscriptIngestPreAuthRateLimit,
  rateLimitErrorResponse,
} from "@/platform/http/rate-limit.server";
import {
  MAX_TRANSCRIPT_REQUEST_BYTES,
  transcriptIngestSchema,
} from "@orbmeet/caption-protocol/transcript-ingest";
import { ingestDeepgramTranscripts } from "@/modules/transcripts/server/ingest";

/**
 * Transcript segments from the transcription agent, signed with the shared
 * service scheme (`@orbmeet/primitives`' `signed-request`): the signature
 * covers the method, path, timestamp and body, under the agent's keyring.
 */
export async function handleInternalTranscriptRequest(request: Request): Promise<Response> {
  const env = await getOptionalEnv();
  if (!env) return new Response("Service unavailable", { status: 503 });
  const transcriptionKeys = parseKeyring(env.TRANSCRIPTION_INTERNAL_KEYS);
  if (!transcriptionKeys) return new Response("Service unavailable", { status: 503 });

  // Bounds an unauthenticated flood before any HMAC work. Scoped to this
  // producer rather than the shared auth budget, which one transcription host's
  // meetings exhausted against each other; see the helper for why.
  try {
    await enforceTranscriptIngestPreAuthRateLimit(env);
  } catch (error) {
    return rateLimitErrorResponse(error, "transcript-ingest-pre-auth");
  }

  const signed = await readSignedRequest(request, transcriptionKeys, MAX_TRANSCRIPT_REQUEST_BYTES);
  if (!signed.ok) return signed.response;
  const body = signed.body;

  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }
  const parsed = v.safeParse(transcriptIngestSchema, json);
  if (!parsed.success) return new Response("Invalid payload", { status: 400 });

  // Every comparable endpoint throttles; this one writes transcript history and
  // reopens AI summary generation, so a secret-holder could otherwise drive
  // unbounded D1 writes and model spend. Keyed per meeting so one busy meeting
  // cannot starve the rest, and so the limit tracks the thing being written.
  try {
    await enforceRateLimit(env, `transcripts:ingest:${parsed.output.meetingId}`);
  } catch (error) {
    return rateLimitErrorResponse(error, "transcript-ingest-meeting");
  }

  return Response.json(await ingestDeepgramTranscripts(createDb(env.DB), env, parsed.output));
}
