import {
  Box,
  StateNode,
  type Editor,
  type TLShape,
  type TLPointerEventInfo,
  type TLShapeId,
  type VecLike,
} from "tldraw";

const HISTORY_KEY = "stroke-erase";

/**
 * The stroke eraser only removes freehand ink (pen + highlighter). Images,
 * PDFs, text, tables, and shapes are deleted by selecting them instead, so a
 * stray drag can never wipe them. Frames and page-frames aren't draw/highlight
 * shapes, so this filter also keeps the eraser off the page structure.
 */
function isEraseableStroke(shape: TLShape): boolean {
  return shape.type === "draw" || shape.type === "highlight";
}

/**
 * Ink strokes the pointer swept between `from` and `to` (both in page space).
 * Testing the segment (not just the current point) means a fast drag across a
 * thin stroke still erases it; passing `from === to` samples a single point,
 * which is what the first pointer-down sample does (see StrokeEraserErasing).
 * Mirrors the native eraser's hit test: a zoom-scaled margin, shape-local
 * segment geometry, and a clip guard so strokes masked away by a page-frame
 * can't be erased through their invisible, clipped-off region.
 */
function collectSweptStrokes(
  editor: Editor,
  from: VecLike,
  to: VecLike,
): TLShapeId[] {
  const margin = editor.options.hitTestMargin / editor.getZoomLevel();

  const sweptBounds = Box.FromPoints([from, to]).expandBy(margin);
  const candidateIds = editor.getShapeIdsInsideBounds(sweptBounds);
  if (candidateIds.size === 0) return [];

  const hits: TLShapeId[] = [];
  for (const shape of editor.getCurrentPageRenderingShapesSorted()) {
    if (!candidateIds.has(shape.id)) continue;
    if (!isEraseableStroke(shape)) continue;
    if (editor.isShapeOrAncestorLocked(shape)) continue;

    // Respect frame clipping: a stroke masked entirely off-frame is invisible
    // (undefined bounds) and its visible remainder lives inside these bounds.
    // Skipping when the sweep misses them keeps the eraser off clipped-away ink.
    const maskedBounds = editor.getShapeMaskedPageBounds(shape);
    if (!maskedBounds || !maskedBounds.collides(sweptBounds)) continue;

    const toLocal = editor.getShapePageTransform(shape).clone().invert();
    const localFrom = toLocal.applyToPoint(from);
    const localTo = toLocal.applyToPoint(to);
    if (editor.getShapeGeometry(shape).hitTestLineSegment(localFrom, localTo, margin)) {
      hits.push(shape.id);
    }
  }
  return hits;
}

class StrokeEraserIdle extends StateNode {
  static override id = "idle";

  override onEnter() {
    this.editor.setCursor({ type: "cross", rotation: 0 });
  }

  override onPointerDown(info: TLPointerEventInfo) {
    this.parent.transition("erasing", info);
  }
}

class StrokeEraserErasing extends StateNode {
  static override id = "erasing";

  private markId = "";

  override onEnter() {
    // One stopping point per gesture, so a single undo restores everything the
    // drag erased.
    this.markId = this.editor.markHistoryStoppingPoint(HISTORY_KEY);
    // First sample is point-only. On pointer-down tldraw leaves
    // `previousPagePoint` at the pointer's prior position (it isn't reset to the
    // down point), and on touch/stylus — which emit no hover moves — that prior
    // position is the *end of the last gesture*, anywhere on the board. Sweeping
    // previous→current here would erase every stroke along that phantom line, so
    // sample the down point alone; the first move then has a correct previous.
    const down = this.editor.inputs.currentPagePoint;
    this.eraseStrokes(down, down);
  }

  override onPointerMove() {
    this.eraseStrokes(
      this.editor.inputs.previousPagePoint,
      this.editor.inputs.currentPagePoint,
    );
  }

  override onPointerUp() {
    this.parent.transition("idle");
  }

  override onCancel() {
    // Bail to this gesture's own mark rather than undo(): if the gesture erased
    // nothing, undo() would revert the user's previous edit instead.
    this.editor.bailToMark(this.markId);
    this.parent.transition("idle");
  }

  override onInterrupt() {
    // Focus loss / pointer-capture loss mid-drag: deletes are already committed
    // to this gesture's mark, so just return to idle for the next gesture.
    this.parent.transition("idle");
  }

  override onComplete() {
    this.parent.transition("idle");
  }

  private eraseStrokes(from: VecLike, to: VecLike) {
    const hits = collectSweptStrokes(this.editor, from, to);
    if (hits.length > 0) this.editor.deleteShapes(hits);
  }
}

export class StrokeEraserTool extends StateNode {
  static override id = "stroke-eraser";
  static override initial = "idle";
  static override children() {
    return [StrokeEraserIdle, StrokeEraserErasing];
  }
  static override isLockable = false;

  override onEnter() {
    this.editor.setCursor({ type: "cross", rotation: 0 });
  }
}
