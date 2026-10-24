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

/**
 * How far into a recording a point of its meeting falls, in seconds. Null
 * when the recording had not begun yet at that point, or when it is unknown
 * when either began: better no way to play from there than the wrong place.
 */
export function recordingSecondsAt(
  meetingSeconds: number,
  meetingStartedAt: string | null,
  recordingFilename: string,
): number | null {
  const recordingStart = recordingStartedAt(recordingFilename);
  if (!meetingStartedAt || !recordingStart) return null;
  const offset = (recordingStart.getTime() - Date.parse(meetingStartedAt)) / 1000;
  if (!Number.isFinite(offset)) return null;
  const seconds = meetingSeconds - Math.max(0, offset);
  return seconds >= 0 ? Math.floor(seconds) : null;
}
