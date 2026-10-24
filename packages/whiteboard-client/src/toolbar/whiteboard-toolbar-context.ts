import { createContext, useContext } from "react";
import type React from "react";
import type { PageManager, WhiteboardPage } from "../pages/page-manager";
import type { WhiteboardToastFn } from "../chrome/whiteboard-toast";
import type { PdfLibrary, UploadFileFn } from "../synced-whiteboard";

export interface WhiteboardToolbarContextValue {
  pageManager: PageManager | null;
  onPagesChanged?: () => void;
  currentPage: number;
  pages: WhiteboardPage[];
  onAddPage?: () => void;
  onInsertPageAfter?: (afterPageNumber: number) => void;
  onClearPage?: () => void;
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
  isLoading?: boolean;
  isConnected?: boolean;
  whiteboardUrl?: string;
  whiteboardToken?: string;
  /** Host-supplied toaster; absent means fall back to tldraw's own toasts. */
  onToast?: WhiteboardToastFn;
}

export const WhiteboardToolbarContext = createContext<WhiteboardToolbarContextValue>({
  pageManager: null,
  currentPage: 1,
  pages: [],
  canEditWhiteboard: false,
  canManagePages: false,
  isCompactChrome: false,
  isAiPanelOpen: false,
  isLoading: false,
  isConnected: false,
});

export function useWhiteboardToolbarContext() {
  return useContext(WhiteboardToolbarContext);
}

const editorInstanceRegistry = new WeakMap<object, {
  imageInputRef: React.RefObject<HTMLInputElement | null>;
  pdfInputRef: React.RefObject<HTMLInputElement | null>;
  pdfSourceOpener: (() => void) | null;
  pasteHandler: (() => void) | null;
}>();

function getRegistry(key: object) {
  let reg = editorInstanceRegistry.get(key);
  if (!reg) {
    reg = {
      imageInputRef: { current: null },
      pdfInputRef: { current: null },
      pdfSourceOpener: null,
      pasteHandler: null,
    };
    editorInstanceRegistry.set(key, reg);
  }
  return reg;
}

export function setImageInputRef(
  key: object,
  ref: React.RefObject<HTMLInputElement | null>,
) {
  getRegistry(key).imageInputRef = ref;
}

export function setPasteHandler(key: object, handler: (() => void) | null) {
  getRegistry(key).pasteHandler = handler;
}

export function setPdfInputRef(
  key: object,
  ref: React.RefObject<HTMLInputElement | null>,
) {
  getRegistry(key).pdfInputRef = ref;
}

/**
 * How the toolbar starts a PDF insert. With a Space library wired up this opens
 * the source dialog; without one it falls through to the disk picker, which is
 * why callers should prefer it over clicking `pdfInputRef` directly.
 */
export function setPdfSourceOpener(key: object, opener: (() => void) | null) {
  getRegistry(key).pdfSourceOpener = opener;
}

export function getEditorActions(key: object) {
  return getRegistry(key);
}
