import { describe, expect, it } from "vitest";
import {
  internalMeetingWhiteboardCaptureKey,
  isMeetingArtifactR2Key,
  meetingIdOfRecordingKey,
  meetingWhiteboardHandoutKey,
  spaceUploadKey,
  stagingKey,
  stagingWhiteboardPdfKey,
  whiteboardPrefix,
  whiteboardRevisionKey,
} from "./r2-keys";

describe("key builders", () => {
  it("build the documented shapes", () => {
    expect(stagingKey("user-u1", "up1")).toBe("staging/user-u1/up1");
    expect(stagingWhiteboardPdfKey("m1", "upload-1"))
      .toBe("staging/meeting-m1-whiteboard-pdf/upload-1.pdf");
    expect(spaceUploadKey("sp1", "a1", "pdf")).toBe("spaces/sp1/uploads/a1.pdf");
    expect(meetingWhiteboardHandoutKey("m1", "publish-1"))
      .toBe("meetings/m1/exports/whiteboard/publish-1.pdf");
    expect(whiteboardRevisionKey("w1", "r1")).toBe("whiteboards/w1/revisions/r1.json");
    expect(internalMeetingWhiteboardCaptureKey("m1", "w1", "c1"))
      .toBe("internal/meetings/m1/canvases/w1/c1.json");
  });

  it("every whiteboard-owned key lives under the whiteboard purge prefix", () => {
    const prefix = whiteboardPrefix("w1");
    expect(whiteboardRevisionKey("w1", "r1").startsWith(prefix)).toBe(true);
  });

  it("reject segments that would introduce path structure", () => {
    expect(() => whiteboardRevisionKey("w1/../w2", "r1")).toThrow(/whiteboardId/);
    expect(() => spaceUploadKey("sp1", "a/1", "pdf")).toThrow(/assetId/);
    expect(() => stagingKey("", "up1")).toThrow(/scope/);
  });
});

describe("meetingIdOfRecordingKey", () => {
  it("names the meeting of a recording key, and of nothing else", () => {
    expect(meetingIdOfRecordingKey("meetings/m1/recordings/orbmeet-m1-2026-10-08T124500.mp4")).toBe("m1");
    expect(meetingIdOfRecordingKey("meetings/m1/exports/whiteboard/p.pdf")).toBeNull();
    expect(meetingIdOfRecordingKey("meetings/m1/recordings/a/b.mp4")).toBeNull();
    expect(meetingIdOfRecordingKey("meetings/../recordings/a.mp4")).toBeNull();
    expect(meetingIdOfRecordingKey("meetings/m1/recordings/")).toBeNull();
    expect(meetingIdOfRecordingKey("internal/meetings/m1/recordings/a.mp4")).toBeNull();
  });
});

describe("isMeetingArtifactR2Key", () => {
  it("accepts keys under the matching artifact prefix", () => {
    expect(isMeetingArtifactR2Key("recording", { meetingId: "m1" }, "meetings/m1/recordings/eg.mp4")).toBe(true);
    expect(
      isMeetingArtifactR2Key("whiteboard_pdf", { meetingId: "m1" }, "meetings/m1/exports/whiteboard/publish-1.pdf"),
    ).toBe(true);
  });

  it("rejects other entities' keys and cross-type keys", () => {
    expect(isMeetingArtifactR2Key("recording", { meetingId: "m1" }, "meetings/m2/recordings/eg.mp4")).toBe(false);
    expect(isMeetingArtifactR2Key("recording", { meetingId: "m1" }, "internal/meetings/m1/recorder/1.png")).toBe(false);
    expect(
      isMeetingArtifactR2Key("whiteboard_pdf", { meetingId: "m1" }, "meetings/m2/exports/whiteboard.pdf"),
    ).toBe(false);
  });
});
