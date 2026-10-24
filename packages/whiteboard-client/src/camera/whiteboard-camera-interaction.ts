import type { Editor } from "tldraw";

export interface WhiteboardInputEvent {
  type: string;
  name: string;
}

export function isWhiteboardCameraInteractionActive(editor: Editor): boolean {
  return (
    editor.inputs.getIsPointing() ||
    editor.inputs.getIsDragging() ||
    editor.inputs.getIsPinching()
  );
}

/**
 * Whether `event` left the board with no gesture in progress. Judged from the
 * editor's inputs, which tldraw updates before it emits the event, not from
 * the event's name: tldraw renames every middle- and right-button pointer
 * event `middle_click` / `right_click`, release included, so a middle-drag
 * pan never emits a `pointer_up`.
 */
export function isWhiteboardCameraInteractionEndEvent(
  editor: Editor,
  event: WhiteboardInputEvent,
): boolean {
  return (
    (event.type === "pointer" || event.type === "pinch") &&
    !isWhiteboardCameraInteractionActive(editor)
  );
}
