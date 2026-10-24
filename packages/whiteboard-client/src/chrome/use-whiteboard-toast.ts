import { useMemo } from "react";
import { useToasts } from "tldraw";

import type { WhiteboardToast } from "./whiteboard-toast";
import { useWhiteboardToolbarContext } from "../toolbar/whiteboard-toolbar-context";

/** Prefer the host app's toaster because the meeting whiteboard hides tldraw's UI. */
export function useWhiteboardToast(): (toast: WhiteboardToast) => void {
  const { onToast } = useWhiteboardToolbarContext();
  const tldrawToasts = useToasts();
  return useMemo(
    () => (toast: WhiteboardToast) => {
      if (onToast) {
        onToast(toast);
        return;
      }
      tldrawToasts.addToast({ title: toast.title, description: toast.description });
    },
    [onToast, tldrawToasts],
  );
}
