import { useCallback } from "react";
import { useToast } from "@orbmeet/ui/react";
import type { WhiteboardToast } from "@orbmeet/whiteboard-client/react";

/**
 * Adapts notifications raised inside `@orbmeet/whiteboard-client` to the app's
 * toast queue (tldraw mounts with `hideUi`, so its built-in toasts are hidden).
 */
export function useWhiteboardToastAdapter() {
  const { add } = useToast();
  return useCallback(
    (toast: WhiteboardToast) => {
      add({
        title: toast.title,
        description: toast.description,
        data: { variant: toast.variant ?? "info" },
      });
    },
    [add],
  );
}
