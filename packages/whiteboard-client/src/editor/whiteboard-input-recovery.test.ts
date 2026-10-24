import { describe, expect, it, vi } from "vitest";
import type { Editor } from "tldraw";
import {
  installWhiteboardInputRecovery,
  pointerDownReusesActivePointer,
  pointerMoveShowsReleasedPointer,
  recoverInterruptedWhiteboardInput,
  type WhiteboardPointerSnapshot,
} from "./whiteboard-input-recovery";

const POINTER: WhiteboardPointerSnapshot = {
  pointerId: 7,
  button: 0,
  isPen: true,
  point: { x: 120, y: 80, z: 0.5 },
  shiftKey: false,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  accelKey: false,
};

function editorStub(isPointing: boolean) {
  const order: string[] = [];
  const complete = vi.fn(() => {
    order.push("complete");
  });
  const dispatch = vi.fn(() => {
    order.push("dispatch");
  });
  const editor = {
    inputs: { getIsPointing: () => isPointing },
    complete,
    dispatch,
  } as unknown as Pick<Editor, "complete" | "dispatch" | "inputs">;

  return { editor, complete, dispatch, order };
}

describe("recoverInterruptedWhiteboardInput", () => {
  it("completes the tool before clearing pointer state through pointer_up", () => {
    const { editor, complete, dispatch, order } = editorStub(true);

    expect(recoverInterruptedWhiteboardInput(editor, POINTER)).toBe(true);
    expect(order).toEqual(["complete", "dispatch"]);
    expect(complete).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledWith({
      type: "pointer",
      target: "canvas",
      name: "pointer_up",
      ...POINTER,
    });
  });

  it("does nothing after tldraw has already processed pointer_up", () => {
    const { editor, complete, dispatch } = editorStub(false);

    expect(recoverInterruptedWhiteboardInput(editor, POINTER)).toBe(false);
    expect(complete).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe("pointerDownReusesActivePointer", () => {
  it("detects a new press from the pointer whose release was lost", () => {
    expect(pointerDownReusesActivePointer(7, { pointerId: 7 })).toBe(true);
  });

  it("preserves a second touch pointer for pinch gestures", () => {
    expect(pointerDownReusesActivePointer(7, { pointerId: 8 })).toBe(false);
  });
});

describe("pointerMoveShowsReleasedPointer", () => {
  it("detects mouse and pen movement after a missing pointer_up", () => {
    expect(pointerMoveShowsReleasedPointer({ pointerType: "mouse", buttons: 0 })).toBe(true);
    expect(pointerMoveShowsReleasedPointer({ pointerType: "pen", buttons: 0 })).toBe(true);
  });

  it("does not end active buttons or infer touch state from buttons", () => {
    expect(pointerMoveShowsReleasedPointer({ pointerType: "mouse", buttons: 1 })).toBe(false);
    expect(pointerMoveShowsReleasedPointer({ pointerType: "pen", buttons: 1 })).toBe(false);
    expect(pointerMoveShowsReleasedPointer({ pointerType: "touch", buttons: 0 })).toBe(false);
  });
});

describe("installWhiteboardInputRecovery", () => {
  /** An editor and DOM in which tldraw handles each press after the capture phase. */
  function setup() {
    const doc = Object.assign(new EventTarget(), { visibilityState: "visible", defaultView: new EventTarget() });
    const container = Object.assign(new EventTarget(), { ownerDocument: doc });
    let pointing = false;
    let listener: ((info: unknown) => void) | null = null;
    const complete = vi.fn();
    const editor = {
      getContainer: () => container,
      inputs: { getIsPointing: () => pointing },
      on: (_name: string, handler: (info: unknown) => void) => { listener = handler; },
      off: () => { listener = null; },
      complete,
      dispatch: vi.fn(),
    } as unknown as Editor;
    installWhiteboardInputRecovery(editor);
    const domEvent = (type: string, pointerId: number) =>
      Object.assign(new Event(type), { pointerId, buttons: 1, pointerType: "touch" });
    const press = (pointerId: number) => {
      doc.dispatchEvent(domEvent("pointerdown", pointerId));
      pointing = true;
      listener?.({ ...POINTER, type: "pointer", name: "pointer_down", pointerId });
    };
    const cancel = (pointerId: number) => doc.dispatchEvent(domEvent("pointercancel", pointerId));
    return { press, cancel, complete };
  }

  it("never completes a pen stroke because a palm touch was cancelled (REVIEW #2)", () => {
    const { press, cancel, complete } = setup();
    press(1); // the pen, drawing
    press(2); // a palm lands mid-stroke
    cancel(2); // Safari's palm rejection
    expect(complete).not.toHaveBeenCalled();
  });

  it("still recovers the gesture's own pointer when it is cancelled", () => {
    const { press, cancel, complete } = setup();
    press(1);
    cancel(1);
    expect(complete).toHaveBeenCalledOnce();
  });
});
