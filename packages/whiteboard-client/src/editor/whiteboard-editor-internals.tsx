import { useEffect } from "react";
import { useEditor } from "tldraw";
import { installWhiteboardInputRecovery } from "./whiteboard-input-recovery";

const PEN_MODE_TOOL_IDS = new Set([
  "draw",
  "highlight",
  "eraser",
  "stroke-eraser",
  "laser",
]);

export const MAX_SAFE_VIEWPORT_DIMENSION = 8192;
export const MAX_SAFE_CAMERA_TRANSLATE = 1_000_000;

const USER_COLOR_PALETTE = [
  "#0f766e",
  "#2563eb",
  "#7c3aed",
  "#c2410c",
  "#be123c",
  "#047857",
  "#0369a1",
  "#a16207",
];

export function userColorForId(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i += 1) {
    hash = (hash * 31 + userId.charCodeAt(i)) | 0;
  }
  return (
    USER_COLOR_PALETTE[Math.abs(hash) % USER_COLOR_PALETTE.length] ??
    USER_COLOR_PALETTE[0]
  );
}

export function WhiteboardInputRecovery() {
  const editor = useEditor();

  useEffect(() => installWhiteboardInputRecovery(editor), [editor]);

  return null;
}

// Exits pen mode when the user switches to a non-pen tool so touch input
// filtering doesn't persist across tool changes on tablet/stylus devices.
export function WhiteboardPenModeBridge() {
  const editor = useEditor();

  useEffect(() => {
    const clearPenModeForTouchTools = () => {
      const instanceState = editor.getInstanceState();
      if (!instanceState.isPenMode) return;
      if (PEN_MODE_TOOL_IDS.has(editor.getCurrentToolId())) return;
      if (editor.inputs.getIsPointing() || editor.inputs.getIsDragging()) return;

      editor.updateInstanceState({ isPenMode: false });
    };

    clearPenModeForTouchTools();
    return editor.store.listen(clearPenModeForTouchTools, { scope: "session" });
  }, [editor]);

  return null;
}
