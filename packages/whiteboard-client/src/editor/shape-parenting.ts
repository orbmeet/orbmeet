import type { Editor, TLShapeId } from "tldraw";
import type { PageManager } from "../pages/page-manager";
import { getDocumentTextBoxLayout } from "./document-text";
import { isPageFrameShape } from "@orbmeet/whiteboard-core/page-frame-model";
import { findLooseShapeOwnerIndex } from "@orbmeet/whiteboard-core/page-geometry";
import { emitWhiteboardError } from "../chrome/whiteboard-error-event";

/**
 * The page a shape centred at (`x`, `y`) belongs to, or null when it is off
 * the pages: beside them, above the first, or past the bottom of the last.
 *
 * Down the stack the owner is the core's (`findLooseShapeOwnerIndex`), the
 * same rule the room applies to loose content: a centre in the gap between
 * two pages belongs to the page above. A stroke carried from one page onto
 * the next is kept on the first, not deleted for straddling the seam.
 */
function findFrameForPoint(
  editor: Editor,
  pageManager: PageManager | null,
  x: number,
  y: number
): TLShapeId | null {
  if (!pageManager) return null;

  const pages = pageManager.getPages();
  const ownerIndex = findLooseShapeOwnerIndex(pages, y);
  if (ownerIndex < 0) return null;
  const last = pages[pages.length - 1];
  if (y >= last.y + last.height) return null;

  const page = pages[ownerIndex];
  const frame = editor.getShape(page.id);
  if (!frame || !isPageFrameShape(frame)) return null;
  if (x < frame.x || x >= frame.x + frame.props.w) return null;
  return page.id;
}

function reparentShapeToFrame(
  editor: Editor,
  shapeId: TLShapeId,
  getPageManager: () => PageManager | null
): boolean {
  const shape = editor.getShape(shapeId);
  if (!shape) return false;
  if (isPageFrameShape(shape)) return true;

  const parent = editor.getShape(shape.parentId);
  let frameId: TLShapeId | null = null;

  if (parent?.type === "frame" || (parent && isPageFrameShape(parent))) {
    frameId = parent.id;
  } else if (parent?.type === "group") {
    // Shape is inside a group. Don't extract it; the group itself will be
    // reparented to the frame, bringing its children along.
    return true;
  } else {
    const bounds = editor.getShapePageBounds(shapeId);
    if (!bounds) return false;

    frameId = findFrameForPoint(editor, getPageManager(), bounds.center.x, bounds.center.y);
    if (!frameId) return false;

    editor.reparentShapes([shapeId], frameId);
  }

  normalizeTextShapeToFrame(editor, shapeId, frameId);
  return true;
}

function normalizeTextShapeToFrame(
  editor: Editor,
  shapeId: TLShapeId,
  frameId: TLShapeId
): void {
  const shape = editor.getShape(shapeId);
  const frame = editor.getShape(frameId);
  if (!shape || shape.type !== "text" || !frame || !isPageFrameShape(frame))
    return;

  const textShape = shape;

  if (!textShape.props.autoSize) return;

  const layout = getDocumentTextBoxLayout({
    frameWidth: frame.props.w,
    x: textShape.x,
  });

  const nextTextAlign =
    textShape.props.textAlign === "middle"
      ? "start"
      : textShape.props.textAlign;

  const widthChanged = Math.abs(textShape.props.w - layout.width) > 0.5;
  const xChanged = Math.abs(textShape.x - layout.x) > 0.5;
  const alignChanged = textShape.props.textAlign !== nextTextAlign;

  if (!widthChanged && !xChanged && !alignChanged) return;

  editor.updateShapes([
    {
      id: textShape.id,
      type: "text",
      x: layout.x,
      props: {
        autoSize: false,
        w: layout.width,
        textAlign: nextTextAlign,
      },
    },
  ]);
}

function rejectShapeOutsidePages(
  editor: Editor,
  shapeId: TLShapeId,
  getPageManager: () => PageManager | null
): boolean {
  const shape = editor.getShape(shapeId);
  if (!shape || isPageFrameShape(shape)) return false;

  const parent = editor.getShape(shape.parentId);
  if (parent?.type === "frame" || (parent && isPageFrameShape(parent)) || parent?.type === "group") return false;

  const bounds = editor.getShapePageBounds(shapeId);
  if (!bounds) return false;

  const frameId = findFrameForPoint(
    editor,
    getPageManager(),
    bounds.center.x,
    bounds.center.y
  );
  if (frameId) return false;

  editor.deleteShapes([shapeId]);
  return true;
}

/**
 * Auto-parents user-created shapes to the current frame for clipping.
 */
export function registerShapeParentingSideEffect(
  editor: Editor,
  getPageManager: () => PageManager | null
): () => void {
  const pendingShapes = new Set<TLShapeId>();
  let rafId: number | null = null;
  let fallbackTimer: ReturnType<typeof setTimeout> | null = null;

  const cancelScheduled = () => {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    if (fallbackTimer !== null) {
      clearTimeout(fallbackTimer);
      fallbackTimer = null;
    }
  };

  // Deferring to a frame is right while the user is mid-gesture, but rAF does
  // not fire at all in a backgrounded tab — where the pending set would sit and
  // grow until the tab came forward. Race a timer so the queue always drains.
  const scheduleProcess = () => {
    if (rafId === null) {
      rafId = requestAnimationFrame(() => {
        rafId = null;
        processPendingShapes();
      });
    }
    if (fallbackTimer === null) {
      fallbackTimer = setTimeout(() => {
        fallbackTimer = null;
        processPendingShapes();
      }, 250);
    }
  };

  const processPendingShapes = () => {
    cancelScheduled();

    const isDrawing =
      editor.inputs.getIsPointing() || editor.inputs.getIsDragging();

    if (isDrawing) {
      scheduleProcess();
      return;
    }

    let rejectedCount = 0;
    for (const shapeId of pendingShapes) {
      const accepted = reparentShapeToFrame(editor, shapeId, getPageManager);
      if (!accepted && rejectShapeOutsidePages(editor, shapeId, getPageManager)) {
        rejectedCount += 1;
      }
    }
    pendingShapes.clear();

    // One toast per batch — a multi-shape paste outside the pages shouldn't
    // stack a notification per shape.
    if (rejectedCount > 0) {
      emitWhiteboardError("Draw within a page — content outside pages is removed.", {
        title: "Outside page",
      });
    }
  };

  const unregister = editor.sideEffects.registerAfterCreateHandler(
    "shape",
    (shape, source) => {
      if (source !== "user") return;
      if (isPageFrameShape(shape)) return;

      pendingShapes.add(shape.id);
      scheduleProcess();
    }
  );

  const unregisterEditing = editor.sideEffects.registerAfterChangeHandler(
    "instance_page_state",
    (prev, next) => {
      if (prev.editingShapeId === next.editingShapeId || !next.editingShapeId)
        return;
      reparentShapeToFrame(editor, next.editingShapeId, getPageManager);
    }
  );

  return () => {
    cancelScheduled();
    // Process any remaining pending shapes synchronously before cleanup
    // so shapes created just before unmount are not left orphaned.
    for (const shapeId of pendingShapes) {
      try {
        const accepted = reparentShapeToFrame(editor, shapeId, getPageManager);
        if (!accepted) {
          rejectShapeOutsidePages(editor, shapeId, getPageManager);
        }
      } catch {
        // Editor may be tearing down; ignore write errors during cleanup
      }
    }
    pendingShapes.clear();
    unregister();
    unregisterEditing();
  };
}

/**
 * Re-parents all orphaned shapes to their appropriate frames.
 */
export function reparentOrphanedShapes(
  editor: Editor,
  getPageManager: () => PageManager | null
): void {
  const shapes = editor.getCurrentPageShapes();
  const idsByFrame = new Map<TLShapeId, TLShapeId[]>();

  for (const shape of shapes) {
    if (isPageFrameShape(shape)) continue;

    const parent = editor.getShape(shape.parentId);
    if (parent?.type === "frame" || (parent && isPageFrameShape(parent))) {
      normalizeTextShapeToFrame(editor, shape.id, parent.id);
      continue;
    }

    const bounds = editor.getShapePageBounds(shape.id);
    if (!bounds) continue;

    const frameId = findFrameForPoint(editor, getPageManager(), bounds.center.x, bounds.center.y);
    if (!frameId) continue;

    const ids = idsByFrame.get(frameId);
    if (ids) {
      ids.push(shape.id);
    } else {
      idsByFrame.set(frameId, [shape.id]);
    }
  }

  for (const [frameId, shapeIds] of idsByFrame) {
    editor.reparentShapes(shapeIds, frameId);
    for (const shapeId of shapeIds) {
      normalizeTextShapeToFrame(editor, shapeId, frameId);
    }
  }
}
