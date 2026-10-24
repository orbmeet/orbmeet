import * as v from "valibot";

/**
 * The durable transcript's way in: the transcription agent posts the finals it
 * journaled to the app, signed with the agent's keyring (`@orbmeet/primitives`'
 * signed requests), and the app commits them. Both sides read this one
 * contract, so the agent never journals a segment the app will refuse.
 */
export const TRANSCRIPT_INGEST_PATH = "/api/internal/transcripts" as const;

/** A final's text; the agent cuts a longer one to this rather than lose it. */
export const MAX_TRANSCRIPT_SEGMENT_TEXT_LENGTH = 32_768;
export const MAX_TRANSCRIPT_SEGMENTS_PER_REQUEST = 100;
/** The request body the app reads at most. */
export const MAX_TRANSCRIPT_REQUEST_BYTES = 256 * 1_024;

const text = (max: number) => v.pipe(v.string(), v.trim(), v.nonEmpty(), v.maxLength(max));
const id = v.pipe(v.string(), v.nonEmpty(), v.maxLength(200));

export const transcriptSegmentSchema = v.object({
  text: text(MAX_TRANSCRIPT_SEGMENT_TEXT_LENGTH),
  /** When the speech began, in ms since the epoch. */
  startedAt: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
  language: v.optional(text(35)),
  /** Unique for the participant in the meeting: a repeated segment is committed once. */
  segmentId: text(200),
});

export const transcriptIngestSchema = v.object({
  meetingId: id,
  participantIdentity: id,
  segments: v.pipe(v.array(transcriptSegmentSchema), v.nonEmpty(), v.maxLength(MAX_TRANSCRIPT_SEGMENTS_PER_REQUEST)),
});

export type TranscriptSegment = v.InferOutput<typeof transcriptSegmentSchema>;
export type TranscriptIngest = v.InferOutput<typeof transcriptIngestSchema>;
