const LIVEKIT_MEETING_ROOM_PREFIX = "meet-";

export type LiveKitMeetingRoomName = `${typeof LIVEKIT_MEETING_ROOM_PREFIX}${string}`;

/** LiveKit room name shared by the edge and whiteboard planes for a meeting. */
export function liveKitMeetingRoomName(meetingId: string): LiveKitMeetingRoomName {
  return `${LIVEKIT_MEETING_ROOM_PREFIX}${meetingId}`;
}

/** Returns the meeting id for a meeting-scoped LiveKit room, else null. */
export function meetingIdFromLiveKitRoom(roomName: string | undefined | null): string | null {
  if (!roomName?.startsWith(LIVEKIT_MEETING_ROOM_PREFIX)) return null;
  return roomName.slice(LIVEKIT_MEETING_ROOM_PREFIX.length);
}
