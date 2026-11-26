/**
 * What a recording's file is called. LiveKit fills `{time}` with the moment
 * the recording began, in UTC, as `2006-01-02T150405`. The name is the only
 * record of when a recording began, and a recap needs that to play from a
 * point in the meeting: recording starts when someone presses it, not when
 * the meeting does.
 */
export const RECORDING_FILE_TEMPLATE = "{room_name}-{time}.mp4";

const STARTED_AT = /(\d{4})-(\d{2})-(\d{2})T(\d{2})(\d{2})(\d{2})\.mp4$/;

/** When a recording began, read from its file's name; null for a name not made from the template. */
export function recordingStartedAt(filename: string): Date | null {
  const match = STARTED_AT.exec(filename);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  const at = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return Number.isNaN(at.getTime()) ? null : at;
}
