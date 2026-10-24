import type { Editor, TLEventInfo, TLPointerEventInfo } from "tldraw";

export interface WhiteboardPointerSnapshot {
  pointerId: number;
  button: number;
  isPen: boolean;
  point: { x: number; y: number; z?: number };
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  accelKey: boolean;
}

type RecoverableEditor = Pick<Editor, "complete" | "dispatch" | "inputs">;

function snapshotWhiteboardPointer(
  info: TLPointerEventInfo,
): WhiteboardPointerSnapshot {
  return {
    pointerId: info.pointerId,
    button: info.button,
    isPen: info.isPen,
    point: { x: info.point.x, y: info.point.y, z: info.point.z },
    shiftKey: info.shiftKey,
    altKey: info.altKey,
    ctrlKey: info.ctrlKey,
    metaKey: info.metaKey,
    accelKey: info.accelKey,
  };
}

export function pointerMoveShowsReleasedPointer(event: Pick<PointerEvent, "buttons" | "pointerType">) {
  return event.pointerType !== "touch" && event.buttons === 0;
}

export function pointerDownReusesActivePointer(
  activePointerId: number,
  event: Pick<PointerEvent, "pointerId">,
) {
  return activePointerId === event.pointerId;
}

export function recoverInterruptedWhiteboardInput(
  editor: RecoverableEditor,
  pointer: WhiteboardPointerSnapshot,
): boolean {
  if (!editor.inputs.getIsPointing()) return false;

  // `complete` is tldraw's public boundary for finishing the active tool state.
  // A synthetic pointer-up then clears InputsManager's pointing/dragging/button
  // state through the normal event pipeline, without reaching into internals.
  editor.complete();
  editor.dispatch({
    type: "pointer",
    target: "canvas",
    name: "pointer_up",
    ...pointer,
  });
  return true;
}

export function installWhiteboardInputRecovery(editor: Editor): () => void {
  const container = editor.getContainer();
  const doc = container.ownerDocument;
  const win = doc.defaultView ?? window;
  let activePointer: WhiteboardPointerSnapshot | null = null;
  // Set by the capture-phase DOM pointerdown, which runs before tldraw: the
  // pointer whose press starts a gesture. A press while another pointer is
  // already down (a palm under a pen, a second pinch finger) joins a gesture
  // and must never become the pointer recovery acts on.
  let gestureStartingPointerId: number | null = null;

  const recover = () => {
    const pointer = activePointer;
    activePointer = null;
    if (!pointer) return;
    recoverInterruptedWhiteboardInput(editor, pointer);
  };

  const handleEditorEvent = (info: TLEventInfo) => {
    if (info.type !== "pointer") return;

    if (info.name === "pointer_up") {
      if (activePointer?.pointerId === info.pointerId) activePointer = null;
      return;
    }

    if (info.name === "pointer_down") {
      const startsGesture = gestureStartingPointerId === info.pointerId || activePointer === null;
      gestureStartingPointerId = null;
      if (startsGesture && editor.inputs.getIsPointing()) {
        activePointer = snapshotWhiteboardPointer(info);
      }
      return;
    }

    if (info.name === "pointer_move" && activePointer?.pointerId === info.pointerId) {
      activePointer = snapshotWhiteboardPointer(info);
    }
  };

  const handlePointerCancel = (event: PointerEvent) => {
    if (activePointer?.pointerId === event.pointerId) recover();
  };

  const handlePointerDown = (event: PointerEvent) => {
    // A new press cannot begin while the previous physical pointer is still
    // down. Recover before tldraw handles this event so the new gesture starts
    // from its tool's idle state. Different touch pointer ids may be a valid
    // second finger, so only treat reuse of the active id as proof of a lost up.
    if (
      activePointer &&
      pointerDownReusesActivePointer(activePointer.pointerId, event) &&
      editor.inputs.getIsPointing()
    ) {
      recover();
    }
    // A press with nothing else down starts a gesture, replacing any pointer
    // left armed by a gesture whose ups tldraw consumed (a pinch).
    gestureStartingPointerId = editor.inputs.getIsPointing() ? null : event.pointerId;
  };

  const handlePointerMove = (event: PointerEvent) => {
    if (
      activePointer?.pointerId === event.pointerId &&
      pointerMoveShowsReleasedPointer(event)
    ) {
      recover();
    }
  };

  const handleLostPointerCapture = (event: PointerEvent) => {
    if (activePointer?.pointerId !== event.pointerId) return;
    // Normal pointer-up releases capture before tldraw dispatches its pointer-up.
    // Defer so that path can clear activePointer first.
    queueMicrotask(() => {
      if (activePointer?.pointerId === event.pointerId) recover();
    });
  };

  const handleVisibilityChange = () => {
    if (doc.visibilityState === "hidden") recover();
  };

  editor.on("event", handleEditorEvent);
  doc.addEventListener("pointercancel", handlePointerCancel, true);
  doc.addEventListener("pointerdown", handlePointerDown, true);
  doc.addEventListener("pointermove", handlePointerMove, true);
  container.addEventListener("lostpointercapture", handleLostPointerCapture, true);
  doc.addEventListener("visibilitychange", handleVisibilityChange);
  win.addEventListener("blur", recover);

  return () => {
    editor.off("event", handleEditorEvent);
    doc.removeEventListener("pointercancel", handlePointerCancel, true);
    doc.removeEventListener("pointerdown", handlePointerDown, true);
    doc.removeEventListener("pointermove", handlePointerMove, true);
    container.removeEventListener("lostpointercapture", handleLostPointerCapture, true);
    doc.removeEventListener("visibilitychange", handleVisibilityChange);
    win.removeEventListener("blur", recover);
  };
}
