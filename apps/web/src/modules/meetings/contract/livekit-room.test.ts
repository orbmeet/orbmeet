import { describe, expect, it } from "vitest";

import { meetingIdFromLiveKitRoom, liveKitMeetingRoomName } from "./livekit-room";

describe("LiveKit Meeting room names", () => {
  it("round-trips a meeting id", () => {
    expect(meetingIdFromLiveKitRoom(liveKitMeetingRoomName("meeting_123"))).toBe("meeting_123");
  });

  it("rejects names outside the meeting namespace", () => {
    expect(meetingIdFromLiveKitRoom("web-egress-room")).toBeNull();
    expect(meetingIdFromLiveKitRoom(null)).toBeNull();
  });
});
