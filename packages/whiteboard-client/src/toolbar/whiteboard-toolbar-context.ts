import { createContext, useContext } from "react";
import type React from "react";
import type { PageManager, WhiteboardPage } from "../pages/page-manager";
import type { WhiteboardToastFn } from "../chrome/whiteboard-toast";
import type { PdfLibrary, UploadFileFn } from "../synced-whiteboard";

/** Imperative triggers registered by canvas overlay components for the toolbar. */
export interface WhiteboardOverlayActions {
  openImagePicker?: () => void;
  openPdfPicker?: () => void;
  paste?: () => void;
}

export interface WhiteboardToolbarContextValue {
  pageManager: PageManager | null;
  onPagesChanged?: () => void;
  currentPage: number;
  pages: WhiteboardPage[];
  onPageChange?: (pageNumber: number) => void;
  canEditWhiteboard: boolean;
  canManagePages?: boolean;
  uploadFile?: UploadFileFn;
  /** Space Files integration. Absent falls back to upload-from-disk only. */
  pdfLibrary?: PdfLibrary;
  getVisibleViewportCenter?: () => { x: number; y: number } | null;
  isCompactChrome?: boolean;
  /** Phone portrait in a meeting: selects the minimal annotate-only toolbar. */
  isPhonePortrait?: boolean;
  aiEnabled?: boolean;
  onToggleAi?: () => void;
  isAiPanelOpen?: boolean;
  whiteboardUrl?: string;
  whiteboardToken?: string;
  /** Host-supplied toaster; absent means fall back to tldraw's own toasts. */
  onToast?: WhiteboardToastFn;
  overlayActionsRef?: React.RefObject<WhiteboardOverlayActions>;
}

export const WhiteboardToolbarContext = createContext<WhiteboardToolbarContextValue>({
  pageManager: null,
  currentPage: 1,
  pages: [],
  canEditWhiteboard: false,
  canManagePages: false,
  isCompactChrome: false,
  isAiPanelOpen: false,
});

export function useWhiteboardToolbarContext() {
  return useContext(WhiteboardToolbarContext);
}
