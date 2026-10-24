import { MEETING_CODE_REGEX } from "@/modules/meetings/contract/constants";

const MEETING_WHITEBOARD_HASH = "#whiteboard" as const;

export function meetingEntryPath(code: string): `/${string}` {
  assertMeetingCode(code);
  return `/${code}`;
}

export function meetingHistoryPath(meetingId: string): `/meetings/${string}` {
  if (!meetingId.trim()) throw new Error("Meeting ID is required");
  return `/meetings/${encodeURIComponent(meetingId)}`;
}

export function meetingWhiteboardPath(meetingId: string): string {
  return `${meetingHistoryPath(meetingId)}${MEETING_WHITEBOARD_HASH}`;
}

function assertMeetingCode(code: string): void {
  if (!MEETING_CODE_REGEX.test(code)) throw new Error(`Invalid meeting code: ${code}`);
}
