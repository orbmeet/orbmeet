import type { PublicTranscript } from "@orbmeet/public-api-contract";

import {
  MAX_PAGINATION_PAGES,
  parseResponse,
  publicMeetingResponseSchema,
  publicMeetingTranscriptPageResponseSchema,
  publicTranscriptSchema,
  type ApiRequest,
  type RetrievedMeeting,
} from "./api.ts";
import type { ParsedArgs } from "./args.ts";
import { meetingSelectionParams, type MeetingInclude } from "./selectors.ts";

const PAGE_SIZE = 500;

export interface RetrievedMeetingResult {
  /** The API response as received, for --raw output. */
  raw: unknown;
  data: RetrievedMeeting;
}

/**
 * Validate one transcript payload against the shared contract. The label
 * keeps the CLI's stable, position-aware error ("response" for the initial
 * payload, "page" for a continuation envelope).
 */
function parseTranscript(value: unknown, label: string): PublicTranscript {
  return parseResponse(publicTranscriptSchema, value, `Orb Meet API returned an invalid transcript ${label}`);
}

function readTranscriptPage(response: unknown, label: string): PublicTranscript {
  const { data } = parseResponse(
    publicMeetingTranscriptPageResponseSchema,
    response,
    `Orb Meet API returned an invalid transcript ${label}`,
  );
  return data.transcript;
}

export function parseTranscriptLimit(value: string | undefined): number {
  if (value === undefined) return Infinity;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("--transcript-limit must be a whole number of segments, at least 1");
  }
  return limit;
}

export async function retrieveMeeting(
  request: ApiRequest,
  args: ParsedArgs,
  includes: readonly MeetingInclude[],
  maxSegments = Infinity,
): Promise<RetrievedMeetingResult> {
  const params = meetingSelectionParams(args);
  for (const include of includes) params.append("include", include);
  if (includes.includes("transcript") && Number.isFinite(maxSegments)) {
    params.set("transcriptLimit", String(Math.min(maxSegments, PAGE_SIZE)));
  }
  const initial = await request(`/api/v1/meetings/?${params.toString()}`);
  const envelopeData = parseResponse(publicMeetingResponseSchema, initial).data;
  const { transcript } = envelopeData;
  // The envelope schema leaves the transcript section unknown, so validate it
  // whenever the server sent one — even if it was not requested — before
  // re-typing the payload. `undefined` (absent) and `null` (unavailable) both
  // stay out of pagination.
  const initialTranscript = transcript === undefined || transcript === null
    ? undefined
    : parseTranscript(transcript, "response");
  const data: RetrievedMeeting = { ...envelopeData, transcript: initialTranscript };
  if (!includes.includes("transcript") || initialTranscript === undefined) {
    return { raw: initial, data };
  }
  if (!initialTranscript.nextCursor && initialTranscript.segments.length <= maxSegments) {
    return { raw: initial, data };
  }

  let segments = [...initialTranscript.segments];
  let cursor = initialTranscript.nextCursor ?? null;
  const seenCursors = new Set<string>();
  let pages = 0;
  while (cursor && segments.length < maxSegments) {
    if (++pages > MAX_PAGINATION_PAGES) {
      throw new Error(
        `Transcript pagination did not finish within ${MAX_PAGINATION_PAGES} pages; aborting`,
      );
    }
    const cursorKey = `${cursor.startedAt}:${cursor.id}`;
    if (seenCursors.has(cursorKey)) {
      throw new Error("Transcript pagination entered a cursor cycle; aborting to avoid an infinite loop");
    }
    seenCursors.add(cursorKey);
    const pageParams = new URLSearchParams({
      meetingId: data.meeting.id,
      include: "transcript",
      cursorStartedAt: String(cursor.startedAt),
      cursorId: cursor.id,
      transcriptLimit: String(Math.min(PAGE_SIZE, maxSegments - segments.length)),
    });
    const page = await request(`/api/v1/meetings/?${pageParams.toString()}`);
    const transcript = readTranscriptPage(page, "page");
    segments.push(...transcript.segments);
    cursor = transcript.nextCursor ?? null;
  }
  const truncated = Boolean(cursor) || segments.length > maxSegments;
  if (segments.length > maxSegments) segments = segments.slice(0, maxSegments);
  data.transcript = { segments, nextCursor: null, ...(truncated ? { truncated } : {}) };
  // The initial envelope was proved to be an object above.
  return { raw: { ...(initial as Record<string, unknown>), data }, data };
}
