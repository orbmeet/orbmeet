import { describe, expect, it } from "vitest";
import { WHITEBOARD_EVENTS } from "@orbmeet/whiteboard-core/protocol";
import { reduceRoomSizeLimited } from "./room-size-state";

describe("reduceRoomSizeLimited", () => {
  it("tracks both the limit and authoritative recovery transitions", () => {
    expect(reduceRoomSizeLimited(false, WHITEBOARD_EVENTS.ROOM_SIZE_LIMIT)).toBe(true);
    expect(reduceRoomSizeLimited(true, WHITEBOARD_EVENTS.ROOM_SIZE_RECOVERED)).toBe(false);
    expect(reduceRoomSizeLimited(true, WHITEBOARD_EVENTS.STATE, false)).toBe(false);
    expect(reduceRoomSizeLimited(false, WHITEBOARD_EVENTS.STATE, true)).toBe(true);
  });
});
