import { WHITEBOARD_EVENTS } from "@orbmeet/whiteboard-core/protocol";

export function reduceRoomSizeLimited(
  current: boolean,
  eventType: unknown,
  stateValue?: unknown,
): boolean {
  if (eventType === WHITEBOARD_EVENTS.ROOM_SIZE_LIMIT) return true;
  if (eventType === WHITEBOARD_EVENTS.ROOM_SIZE_RECOVERED) return false;
  if (eventType === WHITEBOARD_EVENTS.STATE && typeof stateValue === "boolean") {
    return stateValue;
  }
  return current;
}
