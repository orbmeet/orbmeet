import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Box, type Editor, type TLEventInfo } from "tldraw";
import { useCommittedRef } from "@orbmeet/ui/react";
import { applyOrbmeetTldrawTheme } from "./tldraw-theme";
import { clampFinite } from "@orbmeet/primitives";
import {
  MAX_SAFE_CAMERA_TRANSLATE,
  MAX_SAFE_VIEWPORT_DIMENSION,
} from "./whiteboard-editor-internals";
import {
  isWhiteboardCameraInteractionActive,
  isWhiteboardCameraInteractionEndEvent,
} from "../camera/whiteboard-camera-interaction";

interface WhiteboardEditorLifecycleOptions {
  onEditorReady?: (editor: Editor | null) => void;
}

/** Own the tldraw editor instance and its guarded viewport override. */
export function useWhiteboardEditorLifecycle({
  onEditorReady,
}: WhiteboardEditorLifecycleOptions) {
  const [editor, setEditorState] = useState<Editor | null>(null);
  const editorRef = useRef<Editor | null>(null);
  const viewportCleanupRef = useRef<(() => void) | null>(null);
  const onEditorReadyRef = useCommittedRef(onEditorReady);

  // tldraw's onMount: returns the cleanup tldraw runs when this editor goes
  // away, which can happen while the board stays mounted (a fatal sync error,
  // or useSync rebuilding its store). Hooks keyed on `editor` then let go of
  // the disposed one instead of staying subscribed to its store.
  const setEditor = useCallback((nextEditor: Editor) => {
    viewportCleanupRef.current?.();
    editorRef.current = nextEditor;
    const originalUpdateViewportScreenBounds =
      nextEditor.updateViewportScreenBounds.bind(nextEditor);
    let pendingViewportUpdate: {
      screenBounds: Box | HTMLElement;
      center?: boolean;
    } | null = null;

    const applyViewportScreenBounds = (
      screenBounds: Box | HTMLElement,
      center?: boolean,
    ) => {
      let safeBounds = screenBounds;
      if (!(screenBounds instanceof Box)) {
        const rect = screenBounds.getBoundingClientRect();
        const fallbackWidth =
          screenBounds.clientWidth ||
          window.visualViewport?.width ||
          window.innerWidth ||
          1;
        const fallbackHeight =
          screenBounds.clientHeight ||
          window.visualViewport?.height ||
          window.innerHeight ||
          1;
        safeBounds = new Box(
          Number.isFinite(rect.left) ? rect.left : 0,
          Number.isFinite(rect.top) ? rect.top : 0,
          clampFinite(rect.width, 1, MAX_SAFE_VIEWPORT_DIMENSION, fallbackWidth),
          clampFinite(rect.height, 1, MAX_SAFE_VIEWPORT_DIMENSION, fallbackHeight),
        );
      } else {
        safeBounds = new Box(
          Number.isFinite(screenBounds.x) ? screenBounds.x : 0,
          Number.isFinite(screenBounds.y) ? screenBounds.y : 0,
          clampFinite(screenBounds.w, 1, MAX_SAFE_VIEWPORT_DIMENSION, 1),
          clampFinite(screenBounds.h, 1, MAX_SAFE_VIEWPORT_DIMENSION, 1),
        );
      }

      const result = originalUpdateViewportScreenBounds(safeBounds, center);
      const camera = nextEditor.getCamera();
      const needsCameraReset =
        !Number.isFinite(camera.x) ||
        !Number.isFinite(camera.y) ||
        !Number.isFinite(camera.z) ||
        Math.abs(camera.x) > MAX_SAFE_CAMERA_TRANSLATE ||
        Math.abs(camera.y) > MAX_SAFE_CAMERA_TRANSLATE;

      if (needsCameraReset) {
        nextEditor.setCamera(
          {
            x: 0,
            y: 0,
            z: clampFinite(camera.z, 0.05, 4, 1),
          },
          { animation: { duration: 0 } },
        );
      }

      return result;
    };

    const updateViewportScreenBounds = (
      screenBounds: Box | HTMLElement,
      center?: boolean,
    ) => {
      if (isWhiteboardCameraInteractionActive(nextEditor)) {
        pendingViewportUpdate = { screenBounds, center };
        return nextEditor;
      }
      pendingViewportUpdate = null;
      return applyViewportScreenBounds(screenBounds, center);
    };

    nextEditor.updateViewportScreenBounds = updateViewportScreenBounds;
    const handleEditorEvent = (event: TLEventInfo) => {
      if (
        !pendingViewportUpdate ||
        !isWhiteboardCameraInteractionEndEvent(nextEditor, event)
      ) {
        return;
      }
      const pending = pendingViewportUpdate;
      pendingViewportUpdate = null;
      applyViewportScreenBounds(pending.screenBounds, pending.center);
    };
    nextEditor.on("event", handleEditorEvent);
    viewportCleanupRef.current = () => {
      nextEditor.off("event", handleEditorEvent);
      pendingViewportUpdate = null;
      if (nextEditor.updateViewportScreenBounds === updateViewportScreenBounds) {
        nextEditor.updateViewportScreenBounds = originalUpdateViewportScreenBounds;
      }
    };

    applyOrbmeetTldrawTheme(nextEditor);
    setEditorState(nextEditor);
    onEditorReadyRef.current?.(nextEditor);

    return () => {
      if (editorRef.current !== nextEditor) return;
      viewportCleanupRef.current?.();
      viewportCleanupRef.current = null;
      editorRef.current = null;
      setEditorState(null);
      onEditorReadyRef.current?.(null);
    };
  }, [onEditorReadyRef]);

  useEffect(() => () => {
    // Already reported when tldraw unmounted the editor first.
    if (editorRef.current === null) return;
    viewportCleanupRef.current?.();
    viewportCleanupRef.current = null;
    editorRef.current = null;
    onEditorReadyRef.current?.(null);
  }, [onEditorReadyRef]);

  return { editor, setEditor };
}
