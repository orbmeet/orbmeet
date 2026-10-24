import { describe, expect, it } from "vitest";
import type { Editor } from "tldraw";
import {
  isWhiteboardCameraInteractionActive,
  isWhiteboardCameraInteractionEndEvent,
} from "./whiteboard-camera-interaction";

function createEditorInputMock(state: {
  pointing?: boolean;
  dragging?: boolean;
  pinching?: boolean;
}) {
  return {
    inputs: {
      getIsPointing: () => state.pointing ?? false,
      getIsDragging: () => state.dragging ?? false,
      getIsPinching: () => state.pinching ?? false,
    },
  } as unknown as Editor;
}

describe("whiteboard camera interaction", () => {
  it.each([
    { pointing: true },
    { dragging: true },
    { pinching: true },
  ])("treats an active input signal as coordinate-sensitive", (state) => {
    expect(
      isWhiteboardCameraInteractionActive(createEditorInputMock(state)),
    ).toBe(true);
  });

  it("is idle when no pointer or pinch gesture is active", () => {
    expect(
      isWhiteboardCameraInteractionActive(createEditorInputMock({})),
    ).toBe(false);
  });

  it("ends a gesture on the pointer or pinch event that leaves no input active", () => {
    const idle = createEditorInputMock({});
    expect(isWhiteboardCameraInteractionEndEvent(idle, { type: "pointer", name: "pointer_up" })).toBe(true);
    expect(isWhiteboardCameraInteractionEndEvent(idle, { type: "pinch", name: "pinch_end" })).toBe(true);
    // tldraw names a middle- or right-button release this way, never pointer_up.
    expect(isWhiteboardCameraInteractionEndEvent(idle, { type: "pointer", name: "middle_click" })).toBe(true);
    expect(isWhiteboardCameraInteractionEndEvent(idle, { type: "pointer", name: "right_click" })).toBe(true);
    expect(isWhiteboardCameraInteractionEndEvent(idle, { type: "wheel", name: "wheel" })).toBe(false);
  });

  it("does not end a gesture that is still in progress", () => {
    const pointing = createEditorInputMock({ pointing: true });
    expect(isWhiteboardCameraInteractionEndEvent(pointing, { type: "pointer", name: "middle_click" })).toBe(false);
    expect(isWhiteboardCameraInteractionEndEvent(pointing, { type: "pointer", name: "pointer_move" })).toBe(false);
    expect(
      isWhiteboardCameraInteractionEndEvent(createEditorInputMock({ pinching: true }), { type: "pinch", name: "pinch" }),
    ).toBe(false);
  });
});
