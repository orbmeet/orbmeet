import { describe, expect, it } from "vitest";
import { CLOSED_MEETING_SURFACE } from "@/modules/meetings/contract/live-state";
import { selectRecorderStage } from "./recorder-stage";

const open = { open: true, whiteboardId: "wb_1", revision: 2, openRevision: 2 };

describe("selectRecorderStage", () => {
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
