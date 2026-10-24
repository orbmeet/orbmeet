import { useEffect, useMemo, useRef, useState } from "react";
import { useValue, type Editor, type TLShapeId } from "tldraw";
import { useCommittedRef } from "@orbmeet/ui/react";
import type { WhiteboardPage } from "./page-manager";
import { PageNavigator } from "./page-navigator";
import type { WhiteboardChromeConfig } from "../chrome/whiteboard-chrome";

export interface UseWhiteboardPagesOptions {
  editor: Editor | null;
  chrome: WhiteboardChromeConfig;
  syncReady: boolean;
  canManagePages: boolean;
  canAutoCreatePages?: boolean;
}

/** The navigator's actions, safe to call before it exists. */
interface WhiteboardPageActions {
  addPage: () => WhiteboardPage | null;
  /** Insert a new blank page immediately after the current page and navigate to it. */
  insertPageAfterCurrent: () => WhiteboardPage | null;
  /** Insert a new blank page immediately after the given page number and navigate to it. */
  insertPageAfter: (afterPageNumber: number) => WhiteboardPage | null;
  changePage: (pageNumber: number) => void;
  changePageById: (pageId: TLShapeId) => boolean;
  onPagesChanged: () => void;
  commitDeletePage: (pageId: TLShapeId) => void;
  zoomIn: () => void;
  zoomOut: () => void;
  resetView: () => void;
}

export interface UseWhiteboardPagesReturn extends WhiteboardPageActions {
  /** The current editor's pages and camera; null until an editor has mounted. */
  navigator: PageNavigator | null;
  pages: WhiteboardPage[];
  currentPage: number;
  /** Null while the reader has not zoomed: each page is fitted. */
  zoomPercent: number | null;
  initialCameraReady: boolean;
}

const NO_PAGES: WhiteboardPage[] = [];

/** One `PageNavigator` per editor, and what the UI renders from it. */
export function useWhiteboardPages({
  editor,
  chrome,
  syncReady,
  canManagePages,
  canAutoCreatePages = canManagePages,
}: UseWhiteboardPagesOptions): UseWhiteboardPagesReturn {
  const [navigator, setNavigator] = useState<PageNavigator | null>(null);
  const options = useCommittedRef({ chrome, canManagePages, canAutoCreatePages });
  // Where the viewer was, so the next editor's first fit lands there too.
  const carriedPage = useRef(1);

  useEffect(() => {
    if (!editor) return;
    const next = new PageNavigator(editor, { ...options.current, startPage: carriedPage.current });
    setNavigator(next);
    return () => {
      carriedPage.current = next.restoredPage;
      setNavigator(null);
    };
  }, [editor, options]);

  // Before the listeners: the first sync-ready pass records the page to
  // restore, and the first fit waits on a timer anyway.
  useEffect(() => navigator?.setSyncReady(syncReady), [navigator, syncReady]);
  useEffect(() => navigator?.start(), [navigator]);
  useEffect(() => {
    navigator?.configure({ chrome, canAutoCreatePages });
  }, [navigator, chrome, canAutoCreatePages]);
  useEffect(() => {
    navigator?.setCanManagePages(canManagePages);
  }, [navigator, canManagePages]);

  const pages = useValue("whiteboard pages", () => navigator?.pages.get() ?? NO_PAGES, [navigator]);
  const currentPage = useValue("whiteboard current page", () => navigator?.currentPage.get() ?? 1, [navigator]);
  const zoomPercent = useValue("whiteboard zoom percent", () => navigator?.zoomPercent.get() ?? null, [navigator]);
  const initialCameraReady = useValue(
    "whiteboard initial camera ready",
    () => navigator?.initialCameraReady.get() ?? false,
    [navigator],
  );

  const actions = useMemo<WhiteboardPageActions>(() => ({
    addPage: () => navigator?.addPage() ?? null,
    insertPageAfterCurrent: () => navigator?.insertPageAfterCurrent() ?? null,
    insertPageAfter: (afterPageNumber) => navigator?.insertPageAfter(afterPageNumber) ?? null,
    changePage: (pageNumber) => navigator?.changePage(pageNumber),
    changePageById: (pageId) => navigator?.changePageById(pageId) ?? false,
    onPagesChanged: () => navigator?.onPagesChanged(),
    commitDeletePage: (pageId) => navigator?.commitDeletePage(pageId),
    zoomIn: () => navigator?.zoomIn(),
    zoomOut: () => navigator?.zoomOut(),
    resetView: () => navigator?.resetView(),
  }), [navigator]);

  return { navigator, pages, currentPage, zoomPercent, initialCameraReady, ...actions };
}
