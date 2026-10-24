// Window-level channel for surfacing whiteboard errors as toasts. Library code
// (imports, page ops, side effects) has no access to tldraw's toast context, so
// it emits here and the toolbar overlay listener renders the toast.
export const WHITEBOARD_ERROR_EVENT = "orbmeet:whiteboard-error";

export interface WhiteboardErrorDetail {
  message: string;
  title?: string;
}

export function emitWhiteboardError(message: string, options?: { title?: string }): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<WhiteboardErrorDetail>(WHITEBOARD_ERROR_EVENT, {
      detail: { message, title: options?.title },
    }),
  );
}
