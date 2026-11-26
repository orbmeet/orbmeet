import { describe, expect, it } from "vitest";
import { recordingStartedAt } from "./recording-file";

describe("recordingStartedAt", () => {
  it("reads LiveKit's start time from the file name, room names with dashes included", () => {
    expect(recordingStartedAt("meeting-abc-2026-10-15T141500.mp4")?.toISOString()).toBe("2026-10-15T14:15:00.000Z");
  });

  it("knows nothing of a name made some other way", () => {
    expect(recordingStartedAt("upload.mp4")).toBeNull();
    expect(recordingStartedAt("room-2026-10-15T141500.webm")).toBeNull();
  });
});
