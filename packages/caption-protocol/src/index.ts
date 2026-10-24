/**
 * Live captions travel as LiveKit transcription text streams: the agent
 * publishes each caption update on `lk.transcription` on behalf of the
 * speaker, naming the microphone it transcribed. LiveKit lets only an agent
 * publish as someone else; anyone else's streams carry their own identity.
 *
 * A caption is a segment: one utterance, or one part of an utterance too long
 * for a single caption. Its id is unique for the life of the meeting, so a
 * receiver keys everything on it. Each update to a segment carries the whole
 * text so far and a revision that increases with every update to that
 * segment; a receiver keeps the highest revision it has seen. The last update
 * to a segment is final, and every segment the agent opens it also finalizes.
 * A final with no text withdraws the segment: nothing in it was said.
 *
 * Captions are lossy by contract. The durable transcript does not come from
 * here, so a receiver may drop any update without losing the record.
 */
export const CAPTION_TOPIC = "lk.transcription";

export const CAPTION_ATTRIBUTE = {
  trackId: "lk.transcribed_track_id",
  segmentId: "lk.segment_id",
  isFinal: "lk.transcription_final",
  language: "orbmeet.caption_language",
  /** Increases with every update to one segment. */
  revision: "orbmeet.caption_revision",
} as const;

export const MAX_CAPTION_TEXT_LENGTH = 2_000;
export const MAX_CAPTION_ID_LENGTH = 500;
export const MAX_CAPTION_LANGUAGE_LENGTH = 64;

/** What a caption stream's attributes say about it. */
export interface CaptionStreamAttributes {
  trackId: string;
  segmentId: string;
  isFinal: boolean;
  language?: string;
  revision: number;
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function parseIndex(value: string | undefined): number | null {
  if (value === undefined || !/^\d{1,16}$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function encodeCaptionStreamAttributes(caption: CaptionStreamAttributes): Record<string, string> {
  return {
    [CAPTION_ATTRIBUTE.trackId]: caption.trackId,
    [CAPTION_ATTRIBUTE.segmentId]: caption.segmentId,
    [CAPTION_ATTRIBUTE.isFinal]: String(caption.isFinal),
    ...(caption.language === undefined ? {} : { [CAPTION_ATTRIBUTE.language]: caption.language }),
    [CAPTION_ATTRIBUTE.revision]: String(caption.revision),
  };
}

/** Read a caption stream's attributes, or null when any is missing or out of bounds. */
export function parseCaptionStreamAttributes(
  attributes: Readonly<Record<string, string>> | undefined,
): CaptionStreamAttributes | null {
  if (!attributes) return null;
  const trackId = attributes[CAPTION_ATTRIBUTE.trackId];
  const segmentId = attributes[CAPTION_ATTRIBUTE.segmentId];
  const isFinal = attributes[CAPTION_ATTRIBUTE.isFinal];
  const language = attributes[CAPTION_ATTRIBUTE.language];
  const revision = parseIndex(attributes[CAPTION_ATTRIBUTE.revision]);
  if (
    !isBoundedString(trackId, MAX_CAPTION_ID_LENGTH) ||
    !isBoundedString(segmentId, MAX_CAPTION_ID_LENGTH) ||
    (isFinal !== "true" && isFinal !== "false") ||
    (language !== undefined && !isBoundedString(language, MAX_CAPTION_LANGUAGE_LENGTH)) ||
    revision === null
  ) {
    return null;
  }
  return {
    trackId,
    segmentId,
    isFinal: isFinal === "true",
    ...(language === undefined ? {} : { language }),
    revision,
  };
}

export * from "./languages.ts";
