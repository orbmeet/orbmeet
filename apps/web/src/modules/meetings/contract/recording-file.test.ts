import { describe, expect, it } from "vitest";
import { recordingSecondsAt, recordingStartedAt } from "./recording-file";

describe("recordingStartedAt", () => {
  it("reads LiveKit's start time from the file name, room names with dashes included", () => {
    expect(recordingStartedAt("meeting-abc-2026-10-15T141500.mp4")?.toISOString()).toBe("2026-10-15T14:15:00.000Z");
  });

  it("knows nothing of a name made some other way", () => {
    expect(recordingStartedAt("upload.mp4")).toBeNull();
    expect(recordingStartedAt("room-2026-10-15T141500.webm")).toBeNull();
  });
});

describe("recordingSecondsAt", () => {
  const meetingStart = "2026-10-15T14:00:00.000Z";
  const startedAQuarterIn = "room-2026-10-15T141500.mp4";

  it("counts from when the recording began, not the meeting", () => {
    // 22:05 into the meeting is 7:05 into a recording begun at 15:00.
    expect(recordingSecondsAt(22 * 60 + 5, meetingStart, startedAQuarterIn)).toBe(7 * 60 + 5);
  });

  it("has nothing to play from before the recording began", () => {
    expect(recordingSecondsAt(10 * 60, meetingStart, startedAQuarterIn)).toBeNull();
  });

  it("offers no place when either start is unknown", () => {
    expect(recordingSecondsAt(60, null, startedAQuarterIn)).toBeNull();
    expect(recordingSecondsAt(60, meetingStart, "upload.mp4")).toBeNull();
  });

  it("treats a recording begun with the meeting as the meeting's own clock", () => {
    expect(recordingSecondsAt(90, meetingStart, "room-2026-10-15T140000.mp4")).toBe(90);
  });
});
