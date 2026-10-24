const WHITEBOARD_ROOM_PREFIX = "meet-";
const WHITEBOARD_ROOM_ID_REGEX = /^meet-[a-zA-Z0-9_-]{1,64}$/;

export type WhiteboardRoomId = `${typeof WHITEBOARD_ROOM_PREFIX}${string}`;

export function toWhiteboardRoomId(syncRoomId: string): WhiteboardRoomId {
  const whiteboardRoomId = `${WHITEBOARD_ROOM_PREFIX}${syncRoomId}`;
  if (!isWhiteboardRoomId(whiteboardRoomId)) {
    throw new RangeError("Invalid sync room id for a Whiteboard room");
  }
  return whiteboardRoomId;
}

export function isWhiteboardRoomId(value: string): value is WhiteboardRoomId {
  return WHITEBOARD_ROOM_ID_REGEX.test(value);
}

export function syncRoomIdFromWhiteboardRoomId(value: string): string | null {
  return isWhiteboardRoomId(value) ? value.slice(WHITEBOARD_ROOM_PREFIX.length) : null;
}
