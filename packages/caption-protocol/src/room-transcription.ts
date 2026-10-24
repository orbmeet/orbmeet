/**
 * Whether a meeting is transcribing, as its LiveKit room metadata says.
 *
 * The meeting's coordinator writes the room metadata, a JSON object whose
 * `transcription` field is true while speech may go to Deepgram. The
 * transcription agent reads it to decide whether to send audio at all, and the
 * meeting's clients read it to show the state; both read it through here.
 *
 * It fails closed: a room with no metadata yet, or metadata that does not
 * parse, transcribes nothing. Metadata without the field was written before the
 * switch existed, when every meeting transcribed, and still means on.
 */
export const ROOM_TRANSCRIPTION_FIELD = "transcription";

export function roomAllowsTranscription(metadata: string | null | undefined): boolean {
  if (!metadata) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(metadata);
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null) return false;
  const value = (parsed as Record<string, unknown>)[ROOM_TRANSCRIPTION_FIELD];
  return typeof value === "boolean" ? value : true;
}
