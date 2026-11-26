import { describe, expect, it } from "vitest";
import { CLOSED_MEETING_SURFACE } from "@/modules/meetings/contract/live-state";
import {
  isRecorderStartupBlockedByWhiteboard,
  isRecorderStartupBlockedByWhiteboardContent,
  parseRecorderHashParams,
  selectRecorderStage,
  shouldMountRecorderWhiteboard,
  shouldWaitForRecorderWhiteboard,
} from "./recorder-state";

describe("selectRecorderStage", () => {
  const open = { open: true, whiteboardId: "wb_1", revision: 2, openRevision: 2 };

  it("shows a shared screen ahead of the whiteboard", () => {
    expect(selectRecorderStage({ hasScreenShare: true, surface: open })).toBe("screen_share");
  });

  it("shows the whiteboard only while it is open for everyone", () => {
    expect(selectRecorderStage({ hasScreenShare: false, surface: open })).toBe("whiteboard");
    expect(selectRecorderStage({ hasScreenShare: false, surface: { ...open, open: false } })).toBe("video");
  });

  it("shows the participants before the room has reported a surface", () => {
    expect(selectRecorderStage({ hasScreenShare: false, surface: null })).toBe("video");
    expect(selectRecorderStage({ hasScreenShare: false, surface: CLOSED_MEETING_SURFACE })).toBe("video");
  });
});

describe("parseRecorderHashParams", () => {
  it("reads regular fragment params", () => {
    const params = parseRecorderHashParams("#wb_recorder_token=whiteboard-token&url=wss%3A%2F%2Flivekit.example.com&token=lk-token");

    expect(params.get("wb_recorder_token")).toBe("whiteboard-token");
    expect(params.get("url")).toBe("wss://livekit.example.com");
    expect(params.get("token")).toBe("lk-token");
  });

  it("recovers params appended after an existing fragment", () => {
    const params = parseRecorderHashParams(
      "#wb_recorder_token=whiteboard-token?url=wss%3A%2F%2Flivekit.example.com&token=lk-token",
    );

    expect(params.get("wb_recorder_token")).toBe("whiteboard-token");
    expect(params.get("url")).toBe("wss://livekit.example.com");
    expect(params.get("token")).toBe("lk-token");
  });

  it("merges LiveKit params from the real query string", () => {
    const params = parseRecorderHashParams(
      "#wb_recorder_token=whiteboard-token&egress_mode=streaming",
      "?url=wss%3A%2F%2Flivekit.example.com&token=lk-token&layout=",
    );

    expect(params.get("wb_recorder_token")).toBe("whiteboard-token");
    expect(params.get("egress_mode")).toBe("streaming");
    expect(params.get("url")).toBe("wss://livekit.example.com");
    expect(params.get("token")).toBe("lk-token");
  });
});

describe("shouldMountRecorderWhiteboard", () => {
  it("keeps the whiteboard mounted while it is still loading", () => {
    expect(
      shouldMountRecorderWhiteboard({
        hasWhiteboard: true,
        stage: "whiteboard",
        wbStatus: "loading",
      }),
    ).toBe(true);
  });

  it("keeps the whiteboard mounted once it is ready", () => {
    expect(
      shouldMountRecorderWhiteboard({
        hasWhiteboard: true,
        stage: "whiteboard",
        wbStatus: "ready",
      }),
    ).toBe(true);
  });

  it("falls back to video-only layout when the whiteboard errors", () => {
    expect(
      shouldMountRecorderWhiteboard({
        hasWhiteboard: true,
        stage: "whiteboard",
        wbStatus: "error",
      }),
    ).toBe(false);
  });

  it("uses video-only layout when no whiteboard credentials were provided", () => {
    expect(
      shouldMountRecorderWhiteboard({
        hasWhiteboard: false,
        stage: "whiteboard",
        wbStatus: "loading",
      }),
    ).toBe(false);
  });

  it("uses video-only layout when the meeting stage is video", () => {
    expect(
      shouldMountRecorderWhiteboard({
        hasWhiteboard: true,
        stage: "video",
        wbStatus: "ready",
      }),
    ).toBe(false);
  });

  it("uses screen-share/video layout when screen share is the meeting stage", () => {
    expect(
      shouldMountRecorderWhiteboard({
        hasWhiteboard: true,
        stage: "screen_share",
        wbStatus: "ready",
      }),
    ).toBe(false);
  });
});

describe("isRecorderStartupBlockedByWhiteboard", () => {
  it("blocks startup only while active whiteboard is loading", () => {
    expect(
      isRecorderStartupBlockedByWhiteboard({
        hasWhiteboard: true,
        stage: "whiteboard",
        wbStatus: "loading",
        wbTimedOut: false,
      }),
    ).toBe(true);

    expect(
      isRecorderStartupBlockedByWhiteboard({
        hasWhiteboard: true,
        stage: "whiteboard",
        wbStatus: "ready",
        wbTimedOut: false,
      }),
    ).toBe(false);

    expect(
      isRecorderStartupBlockedByWhiteboard({
        hasWhiteboard: true,
        stage: "whiteboard",
        wbStatus: "error",
        wbTimedOut: false,
      }),
    ).toBe(false);
  });

  it("does not block startup for screen share or video stages", () => {
    expect(
      isRecorderStartupBlockedByWhiteboard({
        hasWhiteboard: true,
        stage: "screen_share",
        wbStatus: "loading",
        wbTimedOut: false,
      }),
    ).toBe(false);

    expect(
      isRecorderStartupBlockedByWhiteboard({
        hasWhiteboard: true,
        stage: "video",
        wbStatus: "loading",
        wbTimedOut: false,
      }),
    ).toBe(false);
  });

  it("does not block startup after timeout", () => {
    expect(
      isRecorderStartupBlockedByWhiteboard({
        hasWhiteboard: true,
        stage: "whiteboard",
        wbStatus: "loading",
        wbTimedOut: true,
      }),
    ).toBe(false);
  });
});

describe("shouldWaitForRecorderWhiteboard", () => {
  it("waits when the active stage is whiteboard", () => {
    expect(
      shouldWaitForRecorderWhiteboard({
        egressMode: "recording",
        hasWhiteboard: true,
        stage: "whiteboard",
      }),
    ).toBe(true);

    expect(
      shouldWaitForRecorderWhiteboard({
        egressMode: "streaming",
        hasWhiteboard: true,
        stage: "whiteboard",
      }),
    ).toBe(true);

    expect(
      shouldWaitForRecorderWhiteboard({
        egressMode: "recording",
        hasWhiteboard: true,
        stage: "screen_share",
      }),
    ).toBe(false);

    expect(
      shouldWaitForRecorderWhiteboard({
        egressMode: "recording",
        hasWhiteboard: true,
        stage: "video",
      }),
    ).toBe(false);
  });

  it("does not wait when recorder has no whiteboard credentials", () => {
    expect(
      shouldWaitForRecorderWhiteboard({
        egressMode: "recording",
        hasWhiteboard: false,
        stage: "whiteboard",
      }),
    ).toBe(false);
  });

  it("blocks live streaming on whiteboard loading until the timeout", () => {
    expect(
      isRecorderStartupBlockedByWhiteboard({
        egressMode: "streaming",
        hasWhiteboard: true,
        stage: "whiteboard",
        wbStatus: "loading",
        wbTimedOut: false,
      }),
    ).toBe(true);
  });
});

describe("isRecorderStartupBlockedByWhiteboardContent", () => {
  it("waits briefly for whiteboard content before recording starts", () => {
    expect(
      isRecorderStartupBlockedByWhiteboardContent({
        egressMode: "recording",
        hasWhiteboard: true,
        stage: "whiteboard",
        wbStatus: "ready",
        wbHasContent: false,
        wbContentTimedOut: false,
      }),
    ).toBe(true);

    expect(
      isRecorderStartupBlockedByWhiteboardContent({
        egressMode: "recording",
        hasWhiteboard: true,
        stage: "whiteboard",
        wbStatus: "ready",
        wbHasContent: false,
        wbContentTimedOut: true,
      }),
    ).toBe(false);
  });

  it("does not hold live streaming forever when the whiteboard is empty", () => {
    expect(
      isRecorderStartupBlockedByWhiteboardContent({
        egressMode: "streaming",
        hasWhiteboard: true,
        stage: "whiteboard",
        wbStatus: "ready",
        wbHasContent: false,
        wbContentTimedOut: false,
      }),
    ).toBe(true);

    expect(
      isRecorderStartupBlockedByWhiteboardContent({
        egressMode: "streaming",
        hasWhiteboard: true,
        stage: "whiteboard",
        wbStatus: "ready",
        wbHasContent: false,
        wbContentTimedOut: true,
      }),
    ).toBe(false);
  });

  it("does not wait for content outside the whiteboard stage", () => {
    expect(
      isRecorderStartupBlockedByWhiteboardContent({
        egressMode: "streaming",
        hasWhiteboard: true,
        stage: "video",
        wbStatus: "ready",
        wbHasContent: false,
        wbContentTimedOut: false,
      }),
    ).toBe(false);
  });
});
