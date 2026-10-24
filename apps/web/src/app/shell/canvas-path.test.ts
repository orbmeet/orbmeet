import { describe, expect, it } from "vitest";
import { isCanvasPath } from "./canvas-path";

describe("isCanvasPath", () => {
  it("matches a single whiteboard", () => {
    expect(isCanvasPath("/whiteboards/whiteboard_01abc")).toBe(true);
    expect(isCanvasPath("/whiteboards/whiteboard_01abc/")).toBe(true);
  });

  it("leaves the whiteboard library and other pages alone", () => {
    expect(isCanvasPath("/whiteboards")).toBe(false);
    expect(isCanvasPath("/whiteboards/")).toBe(false);
    expect(isCanvasPath("/meetings/meeting_01abc")).toBe(false);
    expect(isCanvasPath("/home")).toBe(false);
  });
});
