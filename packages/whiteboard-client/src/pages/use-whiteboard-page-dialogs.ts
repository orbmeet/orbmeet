import { useCallback, useEffect, useRef, useState } from "react";
import type { Editor, TLShapeId } from "tldraw";
import type { WhiteboardPage } from "./page-manager";
import { isPageFrameShape } from "@orbmeet/whiteboard-core/page-frame-model";

export interface UseWhiteboardPageDialogsOptions {
  editor: Editor | null;
  pages: WhiteboardPage[];
  currentPage: number;
  canEditWhiteboard: boolean;
  canManagePages: boolean;
  // Performs the actual page deletion + post-delete camera re-anchor. Owned by
  // useWhiteboardPages because it touches the page model and camera; the dialog
  // only decides *which* page and *when* (on confirm).
  commitDeletePage: (pageId: TLShapeId) => void;
}

export interface UseWhiteboardPageDialogsReturn {
  clearPage: (() => void) | undefined;
  showClearPageDialog: boolean;
  setShowClearPageDialog: (show: boolean) => void;
  handleClearPageConfirmed: () => void;
  deletePage: (() => void) | undefined;
  /** Ask to delete a specific page, from the rail's page menu. */
  deletePageByNumber: ((pageNumber: number) => void) | undefined;
  showDeletePageDialog: boolean;
  /**
   * Which page the open dialog is about.
   *
   * Not the current page: the rail can name any page in the document, and a
   * dialog that says "Delete page 2?" while deleting page 7 is worse than no
   * dialog at all.
   */
  pendingDeletePageNumber: number | null;
  setShowDeletePageDialog: (show: boolean) => void;
  handleDeletePageConfirmed: () => void;
}

function pageAt(pages: WhiteboardPage[], pageNumber: number): WhiteboardPage | null {
  return pages[Math.max(1, Math.trunc(pageNumber)) - 1] ?? null;
}

/**
 * What clearing a page removes: the page frame's children, and any loose
 * shape whose centre sits inside the frame.
 */
function shapesOnPage(editor: Editor, pageId: TLShapeId): TLShapeId[] {
  const ids = new Set(editor.getSortedChildIdsForParent(pageId));
  const frame = editor.getShape(pageId);
  if (!frame || !isPageFrameShape(frame)) return Array.from(ids);

  const frameRight = frame.x + frame.props.w;
  const frameBottom = frame.y + frame.props.h;
  for (const shape of editor.getCurrentPageShapes()) {
    if (isPageFrameShape(shape) || ids.has(shape.id)) continue;
    const center = editor.getShapePageBounds(shape)?.center;
    if (!center) continue;
    if (center.x >= frame.x && center.x <= frameRight && center.y >= frame.y && center.y <= frameBottom) {
      ids.add(shape.id);
    }
  }
  return Array.from(ids);
}

// Owns the clear-page / delete-page confirmation dialogs: their visibility, the
// page each dialog is about, captured when it opens, and the confirm handlers.
// Kept out of useWhiteboardPages so that hook stays focused on the page model and
// camera; the only navigation-coupled step (deleting + re-anchoring) is injected.
export function useWhiteboardPageDialogs({
  editor,
  pages,
  currentPage,
  canEditWhiteboard,
  canManagePages,
  commitDeletePage,
}: UseWhiteboardPageDialogsOptions): UseWhiteboardPageDialogsReturn {
  const [showClearPageDialog, setShowClearPageDialog] = useState(false);
  const pendingClearPageIdRef = useRef<TLShapeId | null>(null);
  const [showDeletePageDialog, setShowDeletePageDialog] = useState(false);
  const [pendingDeletePageNumber, setPendingDeletePageNumber] = useState<number | null>(null);
  const pendingDeletePageIdRef = useRef<TLShapeId | null>(null);

  useEffect(() => {
    if (canEditWhiteboard) return;
    pendingClearPageIdRef.current = null;
    setShowClearPageDialog(false);
  }, [canEditWhiteboard]);

  // The dialog names a page, not a set of shapes: what is on that page is
  // decided when the clear is confirmed. A shape dragged off the page while
  // the dialog is open is no longer the page's to clear, and one drawn onto
  // it is.
  const clearPage = useCallback(() => {
    if (!canEditWhiteboard || !editor) return;

    const page = pages[currentPage - 1];
    if (!page) return;
    if (shapesOnPage(editor, page.id).length === 0) return;

    pendingClearPageIdRef.current = page.id;
    setShowClearPageDialog(true);
  }, [canEditWhiteboard, editor, pages, currentPage]);

  const handleClearPageConfirmed = useCallback(() => {
    const pageId = pendingClearPageIdRef.current;
    pendingClearPageIdRef.current = null;
    if (!canEditWhiteboard || !editor || !pageId) return;
    const shapeIds = shapesOnPage(editor, pageId);
    if (shapeIds.length === 0) return;
    editor.deleteShapes(shapeIds);
  }, [canEditWhiteboard, editor]);

  const deletePage = useCallback(() => {
    if (!canManagePages) return;
    if (pages.length <= 1) return;
    const page = pageAt(pages, currentPage);
    if (!page) return;
    pendingDeletePageIdRef.current = page.id;
    setPendingDeletePageNumber(page.number);
    setShowDeletePageDialog(true);
  }, [canManagePages, pages, currentPage]);

  /**
   * Delete a page the viewer is not necessarily standing on.
   *
   * `deletePage` above deletes *the current page*, which is all the bottom
   * pager could ever mean — it has no other page to refer to. The rail does:
   * every page is on screen at once, and asking someone to navigate to a page
   * in order to delete it is a step that exists only because the old control
   * could not express the target.
   */
  const deletePageAt = useCallback(
    (pageNumber: number) => {
      if (!canManagePages) return;
      if (pages.length <= 1) return;
      const page = pageAt(pages, pageNumber);
      if (!page) return;
      pendingDeletePageIdRef.current = page.id;
      setPendingDeletePageNumber(page.number);
      setShowDeletePageDialog(true);
    },
    [canManagePages, pages],
  );

  const handleDeletePageConfirmed = useCallback(() => {
    const pageId = pendingDeletePageIdRef.current;
    if (!pageId) return;
    commitDeletePage(pageId);
    pendingDeletePageIdRef.current = null;
    setPendingDeletePageNumber(null);
  }, [commitDeletePage]);

  return {
    clearPage: canEditWhiteboard ? clearPage : undefined,
    showClearPageDialog,
    setShowClearPageDialog,
    handleClearPageConfirmed,
    deletePage: canManagePages ? deletePage : undefined,
    deletePageByNumber: canManagePages ? deletePageAt : undefined,
    showDeletePageDialog,
    pendingDeletePageNumber,
    setShowDeletePageDialog,
    handleDeletePageConfirmed,
  };
}
