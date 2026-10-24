import { describe, expect, it, vi } from "vitest";
import { Box, type Editor, type StateNode, type TLShapeId } from "tldraw";
import { StrokeEraserTool } from "./stroke-eraser-tool";

type Pt = { x: number; y: number };

interface FakeShape {
  id: TLShapeId;
  type: string;
  center: Pt;
  locked?: boolean;
  /** undefined => fully clipped/invisible; omit => unmasked (always visible). */
  maskedBounds?: Box | null;
}

const UNMASKED = Box.From({ x: -1e4, y: -1e4, w: 2e4, h: 2e4 });
const MARGIN = 10;

function distPointToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

const identityTransform = {
  clone() {
    return this;
  },
  invert() {
    return this;
  },
  applyToPoint(p: Pt) {
    return p;
  },
};

/**
 * Minimal editor stub exercising the geometry the stroke eraser relies on.
 * Transforms are identity, so shape-local space equals page space and each
 * shape is treated as a point for a faithful segment/point hit test.
 */
function makeEditor(shapes: FakeShape[]) {
  const deleteShapes = vi.fn();
  const markHistoryStoppingPoint = vi.fn(() => "mark-1");
  const bailToMark = vi.fn();
  const setCursor = vi.fn();

  const editor = {
    options: { hitTestMargin: MARGIN },
    inputs: { currentPagePoint: { x: 0, y: 0 }, previousPagePoint: { x: 0, y: 0 } },
    getZoomLevel: () => 1,
    getShapeIdsInsideBounds: () => new Set(shapes.map((s) => s.id)),
    getCurrentPageRenderingShapesSorted: () => shapes,
    isShapeOrAncestorLocked: (s: FakeShape) => Boolean(s.locked),
    getShapeMaskedPageBounds: (s: FakeShape) =>
      "maskedBounds" in s ? (s.maskedBounds ?? undefined) : UNMASKED,
    getShapePageTransform: () => identityTransform,
    getShapeGeometry: (s: FakeShape) => ({
      hitTestLineSegment: (a: Pt, b: Pt, margin: number) =>
        distPointToSegment(s.center, a, b) <= margin,
    }),
    deleteShapes,
    markHistoryStoppingPoint,
    bailToMark,
    setCursor,
  };

  return { editor, deleteShapes, markHistoryStoppingPoint, bailToMark };
}

type ErasingState = StateNode & {
  onEnter(): void;
  onPointerMove(): void;
  onCancel(): void;
};

/** Build the real tool tree and return its `erasing` child state node. */
function makeErasingState(editor: ReturnType<typeof makeEditor>["editor"]): ErasingState {
  const tool = new StrokeEraserTool(editor as unknown as Editor);
  const erasing = tool.children?.erasing;
  if (!erasing) throw new Error("erasing child state not constructed");
  return erasing as ErasingState;
}

function id(name: string) {
  return `shape:${name}` as TLShapeId;
}

describe("StrokeEraserTool erasing", () => {
  it("point-samples the down point on enter, not the stale previous→current segment", () => {
    // Regression: on pointer-down tldraw leaves previousPagePoint at the prior
    // pointer position. On touch/stylus that's the end of the last gesture, so a
    // previous→current sweep here would erase every stroke along a phantom line.
    const midStroke: FakeShape = { id: id("mid"), type: "draw", center: { x: 50, y: 50 } };
    const underPointer: FakeShape = { id: id("under"), type: "draw", center: { x: 100, y: 100 } };
    const { editor, deleteShapes, markHistoryStoppingPoint } = makeEditor([midStroke, underPointer]);
    editor.inputs.previousPagePoint = { x: 0, y: 0 };
    editor.inputs.currentPagePoint = { x: 100, y: 100 };

    makeErasingState(editor).onEnter();

    expect(markHistoryStoppingPoint).toHaveBeenCalledTimes(1);
    expect(deleteShapes).toHaveBeenCalledTimes(1);
    expect(deleteShapes).toHaveBeenCalledWith([underPointer.id]);
  });

  it("sweeps the previous→current segment on pointer move", () => {
    const midStroke: FakeShape = { id: id("mid"), type: "draw", center: { x: 50, y: 50 } };
    const { editor, deleteShapes } = makeEditor([midStroke]);
    editor.inputs.previousPagePoint = { x: 0, y: 0 };
    editor.inputs.currentPagePoint = { x: 100, y: 100 };

    makeErasingState(editor).onPointerMove();

    expect(deleteShapes).toHaveBeenCalledWith([midStroke.id]);
  });

  it("only erases draw and highlight ink, never other shapes under the pointer", () => {
    const at = { x: 100, y: 100 };
    const shapes: FakeShape[] = [
      { id: id("draw"), type: "draw", center: at },
      { id: id("hl"), type: "highlight", center: at },
      { id: id("image"), type: "image", center: at },
      { id: id("text"), type: "text", center: at },
      { id: id("table"), type: "table", center: at },
    ];
    const { editor, deleteShapes } = makeEditor(shapes);
    editor.inputs.previousPagePoint = at;
    editor.inputs.currentPagePoint = at;

    makeErasingState(editor).onEnter();

    expect(deleteShapes).toHaveBeenCalledWith([id("draw"), id("hl")]);
  });

  it("skips locked strokes", () => {
    const at = { x: 100, y: 100 };
    const { editor, deleteShapes } = makeEditor([
      { id: id("locked"), type: "draw", center: at, locked: true },
      { id: id("free"), type: "draw", center: at },
    ]);
    editor.inputs.previousPagePoint = at;
    editor.inputs.currentPagePoint = at;

    makeErasingState(editor).onEnter();

    expect(deleteShapes).toHaveBeenCalledWith([id("free")]);
  });

  it("skips strokes clipped away by a page-frame mask", () => {
    const at = { x: 100, y: 100 };
    const { editor, deleteShapes } = makeEditor([
      // Fully clipped (invisible): no masked bounds.
      { id: id("clipped"), type: "draw", center: at, maskedBounds: null },
      // Visible only far from the sweep: masked bounds don't collide.
      {
        id: id("offscreen"),
        type: "draw",
        center: at,
        maskedBounds: Box.From({ x: 500, y: 500, w: 10, h: 10 }),
      },
      { id: id("visible"), type: "draw", center: at },
    ]);
    editor.inputs.previousPagePoint = at;
    editor.inputs.currentPagePoint = at;

    makeErasingState(editor).onEnter();

    expect(deleteShapes).toHaveBeenCalledWith([id("visible")]);
  });

  it("does not touch history when nothing is under the pointer", () => {
    const { editor, deleteShapes } = makeEditor([
      { id: id("far"), type: "draw", center: { x: 999, y: 999 } },
    ]);
    editor.inputs.previousPagePoint = { x: 0, y: 0 };
    editor.inputs.currentPagePoint = { x: 0, y: 0 };

    makeErasingState(editor).onEnter();

    expect(deleteShapes).not.toHaveBeenCalled();
  });

  it("bails to this gesture's own mark on cancel", () => {
    const at = { x: 100, y: 100 };
    const { editor, bailToMark } = makeEditor([{ id: id("draw"), type: "draw", center: at }]);
    editor.inputs.previousPagePoint = at;
    editor.inputs.currentPagePoint = at;

    const erasing = makeErasingState(editor);
    erasing.onEnter();
    erasing.onCancel();

    expect(bailToMark).toHaveBeenCalledWith("mark-1");
  });
});
