import { describe, expect, it } from "vitest";
import { syncRoomIdFromWhiteboardRoomId, toWhiteboardRoomId } from "./whiteboard-room-id.ts";

describe("toWhiteboardRoomId", () => {
  it("creates a validated room id", () => {
    expect(toWhiteboardRoomId("whiteboard_123")).toBe("meet-whiteboard_123");
    expect(syncRoomIdFromWhiteboardRoomId("meet-whiteboard_123")).toBe("whiteboard_123");
  });

  it("rejects values that would escape the room-id and file-name contract", () => {
    expect(() => toWhiteboardRoomId("../other-room")).toThrow(RangeError);
    expect(() => toWhiteboardRoomId("x".repeat(65))).toThrow(RangeError);
  });
});
