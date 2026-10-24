import { describe, expect, it, vi } from "vitest";
import { compileMathInput } from "./math-input";
import { renderKatex } from "./katex-renderer";
import {
  b64Vecs,
  type Editor,
  type TLDrawShape,
  type TLParentId,
  type TLShapeId,
} from "tldraw";

import {
  canRecognizeSelectedInk,
  collectSelectedMathInk,
  isMathInkSelectionCurrent,
  mathInkInputFromLatex,
  placeMathInkRecognition,
  recognizeMathInk,
  repairIncompleteMathInkLatex,
} from "./mathink";

function id(value: string): TLShapeId {
  return `shape:${value}` as TLShapeId;
}

function drawShape(
  shapeId: TLShapeId,
  points: Array<{ x: number; y: number }>,
  parentId = "page:page" as TLParentId,
): TLDrawShape {
  return {
    id: shapeId,
    type: "draw",
    parentId,
    x: 0,
    y: 0,
    rotation: 0,
    index: `a${shapeId}`,
    props: {
      isComplete: true,
      scaleX: 1,
      scaleY: 1,
      segments: [
        {
          type: "free",
          path: b64Vecs.encodePoints(
            points.map((point) => ({ ...point, z: 0.5 })),
          ),
        },
      ],
    },
  } as unknown as TLDrawShape;
}

function editorForShapes(shapes: TLDrawShape[], pageOffset = { x: 0, y: 0 }) {
  let selectedIds = shapes.map((shape) => shape.id);
  let currentShapes = shapes;
  const createShape = vi.fn();
  const deleteShapes = vi.fn();
  const editor = {
    getSelectedShapeIds: () => selectedIds,
    getCurrentPageShapesSorted: () => currentShapes,
    getCurrentPageId: () => "page:page",
    getShape: (shapeId: TLShapeId) => currentShapes.find((shape) => shape.id === shapeId),
    getShapePageTransform: () => ({
      applyToPoint: (point: { x: number; y: number }) => ({
        x: point.x + pageOffset.x,
        y: point.y + pageOffset.y,
      }),
    }),
    markHistoryStoppingPoint: vi.fn(),
    run: (action: () => void) => action(),
    createShape,
    deleteShapes,
    setCurrentTool: vi.fn(),
    setSelectedShapes: vi.fn(),
  } as unknown as Editor;
  return {
    editor,
    createShape,
    deleteShapes,
    setSelectedIds: (ids: TLShapeId[]) => {
      selectedIds = ids;
    },
    setShapes: (next: TLDrawShape[]) => {
      currentShapes = next;
    },
  };
}

describe("MathInk selection extraction", () => {
  it("preserves selected stroke order and converts local points to page space", () => {
    const first = drawShape(id("first"), [
      { x: 0, y: 0 },
      { x: 10, y: 5 },
    ]);
    const second = drawShape(id("second"), [
      { x: 2, y: 3 },
      { x: 4, y: 8 },
    ]);
    const editor = {
      getSelectedShapeIds: () => [second.id, first.id],
      getShape: (shapeId: TLShapeId) => (
        shapeId === first.id ? first : shapeId === second.id ? second : undefined
      ),
      getCurrentPageId: () => "page:page",
      getShapePageTransform: (shape: TLDrawShape) => ({
        applyToPoint: (point: { x: number; y: number }) => ({
          x: point.x + (shape.id === first.id ? 100 : 200),
          y: point.y + 50,
        }),
      }),
    } as unknown as Editor;

    expect(canRecognizeSelectedInk(editor)).toBe(true);
    const result = collectSelectedMathInk(editor);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.selection).toMatchObject({
      shapeIds: [second.id, first.id],
      parentId: "page:page",
      strokes: [
        [[202, 53], [204, 58]],
        [[100, 50], [110, 55]],
      ],
      bounds: { minX: 100, minY: 50, maxX: 204, maxY: 58 },
    });
    expect(result.selection.sourceShapes).toEqual([
      { shape: second },
      { shape: first },
    ]);
  });

  it("rejects a mixed selection", () => {
    const stroke = drawShape(id("ink"), [{ x: 0, y: 0 }]);
    const editor = {
      getSelectedShapeIds: () => [stroke.id, id("text")],
      getShape: (shapeId: TLShapeId) => (
        shapeId === stroke.id ? stroke : { id: id("text"), type: "text" }
      ),
    } as unknown as Editor;

    expect(canRecognizeSelectedInk(editor)).toBe(false);
    expect(collectSelectedMathInk(editor)).toEqual({
      ok: false,
      message: "Select only completed pen strokes to convert them to math.",
    });
  });
});

describe("MathInk selection concurrency", () => {
  it("rejects a source stroke edited while recognition is pending", () => {
    const original = drawShape(id("ink"), [{ x: 0, y: 0 }, { x: 10, y: 10 }]);
    const harness = editorForShapes([original]);
    const collected = collectSelectedMathInk(harness.editor);
    expect(collected.ok).toBe(true);
    if (!collected.ok) return;

    harness.setShapes([{ ...original, x: 40 }]);

    expect(isMathInkSelectionCurrent(harness.editor, collected.selection)).toBe(false);
    expect(() =>
      placeMathInkRecognition(harness.editor, collected.selection, "x", "replace"),
    ).toThrow("selected handwriting changed");
    expect(harness.createShape).not.toHaveBeenCalled();
    expect(harness.deleteShapes).not.toHaveBeenCalled();
  });

  it("rejects movement inherited from a parent without deleting the ink", () => {
    const stroke = drawShape(id("ink"), [{ x: 0, y: 0 }, { x: 10, y: 10 }]);
    const offset = { x: 0, y: 0 };
    const harness = editorForShapes([stroke], offset);
    const collected = collectSelectedMathInk(harness.editor);
    expect(collected.ok).toBe(true);
    if (!collected.ok) return;

    offset.x = 25;

    expect(isMathInkSelectionCurrent(harness.editor, collected.selection)).toBe(false);
    expect(() =>
      placeMathInkRecognition(harness.editor, collected.selection, "x", "replace"),
    ).toThrow("selected handwriting changed");
    expect(harness.deleteShapes).not.toHaveBeenCalled();
  });

  it("requires the same active selection before opening a completed recognition", () => {
    const stroke = drawShape(id("ink"), [{ x: 0, y: 0 }, { x: 10, y: 10 }]);
    const harness = editorForShapes([stroke]);
    const collected = collectSelectedMathInk(harness.editor);
    expect(collected.ok).toBe(true);
    if (!collected.ok) return;

    harness.setSelectedIds([]);

    expect(
      isMathInkSelectionCurrent(harness.editor, collected.selection, { requireSelected: true }),
    ).toBe(false);
    expect(isMathInkSelectionCurrent(harness.editor, collected.selection)).toBe(true);
  });
});

describe("MathInk API", () => {
  it("posts strokes to the same-origin endpoint and parses the bounded response", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("/api/mathink/v1/recognize");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({
        strokes: [[[0, 0], [1, 1]]],
      });
      return Response.json({
        latex: "x^2",
        token_ids: [1, 2],
        points: 12,
        model_step: 70000,
        latency_ms: 123.45,
      });
    });

    await expect(
      recognizeMathInk([[[0, 0], [1, 1]]], {
        token: "whiteboard-token",
        fetcher: fetcher as unknown as typeof fetch,
      }),
    ).resolves.toEqual({
      latex: "x^2",
      modelStep: 70000,
      latencyMs: 123.45,
    });
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: "Bearer whiteboard-token",
    });
  });

  it("turns a rate limit response into a useful error", async () => {
    const fetcher = vi.fn(async () => new Response("", { status: 429 }));
    await expect(
      recognizeMathInk([[[0, 0]]], {
        fetcher: fetcher as unknown as typeof fetch,
      }),
    ).rejects.toThrow("too many requests");
  });
});

describe("MathInk placement", () => {
  it("replaces unchanged source ink with one editable math shape in one action", () => {
    const first = drawShape(id("one"), [{ x: 0, y: 0 }]);
    const second = drawShape(id("two"), [{ x: 100, y: 40 }]);
    const harness = editorForShapes([first, second]);
    const collected = collectSelectedMathInk(harness.editor);
    expect(collected.ok).toBe(true);
    if (!collected.ok) return;

    placeMathInkRecognition(harness.editor, collected.selection, "x^2", "replace");

    expect(harness.createShape).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "math",
        parentId: "page:page",
        x: -70,
        y: -28,
        props: expect.objectContaining({
          input: "\\relax x^2",
          latex: "x^2",
        }),
      }),
    );
    expect(harness.deleteShapes).toHaveBeenCalledWith(collected.selection.shapeIds);
  });

  it("keeps leading-command LaTeX directly editable", () => {
    expect(mathInkInputFromLatex("\\frac{a}{b}")).toBe("\\frac{a}{b}");
  });

  it("keeps inline styling when recognized LaTeX is edited", () => {
    const latex = String.raw`x+\sum_{i=1}^n i`;
    const input = mathInkInputFromLatex(latex);
    const compiled = compileMathInput(input, undefined, false);
    expect(compiled.error).toBeNull();
    expect(compiled.latex).not.toContain("\\displaystyle");
    // The annotation contains the source, but the visual HTML must be identical.
    const visual = (source: string) => renderKatex(source, false)?.split('<span class="katex-html"')[1];
    expect(visual(compiled.latex!)).toBe(visual(latex));
  });
});

describe("MathInk LaTeX repair", () => {
  it("completes only missing trailing group braces", () => {
    expect(repairIncompleteMathInkLatex(String.raw`\sum_{i=1}^{20`)).toEqual({
      latex: String.raw`\sum_{i=1}^{20}`,
      repaired: true,
    });
  });

  it("does not rewrite invalid commands or unmatched closing braces", () => {
    expect(repairIncompleteMathInkLatex(String.raw`\Deltax`)).toEqual({
      latex: String.raw`\Deltax`,
      repaired: false,
    });
    expect(repairIncompleteMathInkLatex("x}")).toEqual({
      latex: "x}",
      repaired: false,
    });
  });

  it("ignores escaped braces when counting groups", () => {
    expect(repairIncompleteMathInkLatex(String.raw`\left\{x`)).toEqual({
      latex: String.raw`\left\{x`,
      repaired: false,
    });
  });
});
