/**
 * Toast channel for the whiteboard package.
 *
 * The meeting mounts `<Tldraw hideUi>`, and tldraw only renders its `Toasts`
 * component inside `TldrawUiContent` — which `hideUi` removes wholesale. Every
 * `useToasts().addToast(...)` in this package was therefore a no-op on screen:
 * failed PDF and image imports, clipboard errors, and the notice explaining
 * that content drawn outside a page frame gets deleted all went nowhere.
 *
 * The host app injects its own toaster through `SyncedWhiteboardProps.onToast`
 * so whiteboard notifications land in the same stack as the rest of the meeting
 * UI. Consumers that render tldraw's own chrome (no `hideUi`) inject nothing and
 * keep falling back to tldraw's toasts.
 */
export interface WhiteboardToast {
  title: string;
  description?: string;
  variant?: "success" | "error" | "info" | "warning";
}

export type WhiteboardToastFn = (toast: WhiteboardToast) => void;
