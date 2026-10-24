import * as v from "valibot";
import {
  createMathShapeProps,
  DEFAULT_MATH_HEIGHT,
  DEFAULT_MATH_WIDTH,
  MATH_SHAPE_TYPE,
  MAX_MATH_INPUT_LENGTH,
} from "@orbmeet/whiteboard-core/math-shape-schema";
import {
  mathInkRecognitionResponseSchema,
  MATHINK_MAX_COORDINATE,
  MATHINK_MAX_RAW_POINTS,
  MATHINK_MAX_STROKES,
  MATHINK_RECOGNIZE_PATH,
} from "@orbmeet/whiteboard-core/mathink-contract";
import {
  createShapeId,
  getPointsFromDrawSegments,
  isShapeId,
  type Editor,
  type TLDrawShape,
  type TLParentId,
  type TLShapeId,
} from "tldraw";

import { getKatexError } from "./katex-renderer";

const INSERT_GAP = 24;

export type MathInkStroke = Array<[number, number]>;

interface MathInkSourceShapeSnapshot {
  shape: TLDrawShape;
}

export interface MathInkSelection {
  shapeIds: TLShapeId[];
  sourceShapes: MathInkSourceShapeSnapshot[];
  parentId: TLParentId;
  strokes: MathInkStroke[];
  bounds: {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
  };
}

export type MathInkSelectionResult =
  | { ok: true; selection: MathInkSelection }
  | { ok: false; message: string };

export interface MathInkRecognition {
  latex: string;
  modelStep: number;
  latencyMs: number;
}

export interface MathInkLatexRepair {
  latex: string;
  repaired: boolean;
}

function selectedDrawShapes(editor: Editor): TLDrawShape[] | null {
  const selectedIds = editor.getSelectedShapeIds();
  if (selectedIds.length === 0 || selectedIds.length > MATHINK_MAX_STROKES) return null;

  const shapes: TLDrawShape[] = [];
  for (const shapeId of selectedIds) {
    const shape = editor.getShape(shapeId);
    if (!shape || shape.type !== "draw") return null;
    shapes.push(shape);
  }
  if (shapes.some((shape) => !shape.props.isComplete || shape.props.segments.length === 0)) {
    return null;
  }
  return shapes;
}

/** Whether the current selection can expose the Convert to math affordance. */
export function canRecognizeSelectedInk(editor: Editor): boolean {
  return selectedDrawShapes(editor) !== null;
}

function roundedCoordinate(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function pageStrokeForShape(editor: Editor, shape: TLDrawShape): MathInkStroke | null {
  const transform = editor.getShapePageTransform(shape);
  const points = getPointsFromDrawSegments(
    shape.props.segments,
    shape.props.scaleX,
    shape.props.scaleY,
  );
  if (points.length === 0) return null;

  const stroke: MathInkStroke = [];
  for (const point of points) {
    const pagePoint = transform.applyToPoint(point);
    if (
      !Number.isFinite(pagePoint.x) ||
      !Number.isFinite(pagePoint.y) ||
      Math.abs(pagePoint.x) > MATHINK_MAX_COORDINATE ||
      Math.abs(pagePoint.y) > MATHINK_MAX_COORDINATE
    ) {
      return null;
    }
    stroke.push([roundedCoordinate(pagePoint.x), roundedCoordinate(pagePoint.y)]);
  }
  return stroke;
}

/**
 * Decode selected tldraw pen shapes into page-space strokes. Shapes are read in
 * rendering order, which preserves ordinary ink creation order unless the ink
 * has subsequently been reordered.
 */
export function collectSelectedMathInk(editor: Editor): MathInkSelectionResult {
  const shapes = selectedDrawShapes(editor);
  if (!shapes) {
    return {
      ok: false,
      message: "Select only completed pen strokes to convert them to math.",
    };
  }

  const strokes: MathInkStroke[] = [];
  let pointCount = 0;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const shape of shapes) {
    const stroke = pageStrokeForShape(editor, shape);
    if (!stroke) {
      return { ok: false, message: "One of the selected strokes is empty or unsupported." };
    }

    pointCount += stroke.length;
    if (pointCount > MATHINK_MAX_RAW_POINTS) {
      return {
        ok: false,
        message: "That selection contains too many points. Convert a smaller expression.",
      };
    }

    for (const [x, y] of stroke) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
    strokes.push(stroke);
  }

  const firstParentId = shapes[0].parentId;
  const parentId = shapes.every((shape) => shape.parentId === firstParentId)
    ? firstParentId
    : editor.getCurrentPageId();

  return {
    ok: true,
    selection: {
      shapeIds: shapes.map((shape) => shape.id),
      sourceShapes: shapes.map((shape) => ({
        shape,
      })),
      parentId,
      strokes,
      bounds: { minX, minY, maxX, maxY },
    },
  };
}

function strokesMatch(left: MathInkStroke, right: MathInkStroke): boolean {
  if (left.length !== right.length) return false;
  return left.every(
    ([leftX, leftY], index) => leftX === right[index][0] && leftY === right[index][1],
  );
}

/**
 * Verify that recognition still refers to the exact ink records and page-space
 * geometry captured when the request started. This includes changes inherited
 * from a moved or transformed parent shape.
 */
export function isMathInkSelectionCurrent(
  editor: Editor,
  selection: MathInkSelection,
  options: { requireSelected?: boolean } = {},
): boolean {
  if (options.requireSelected) {
    const selected = new Set(editor.getSelectedShapeIds());
    if (selected.size !== selection.shapeIds.length) return false;
    if (selection.shapeIds.some((shapeId) => !selected.has(shapeId))) return false;
  }

  if (selection.sourceShapes.length !== selection.strokes.length) return false;
  return selection.sourceShapes.every((snapshot, index) => {
    const shape = editor.getShape(snapshot.shape.id);
    if (!shape || shape.type !== "draw" || shape !== snapshot.shape) {
      return false;
    }
    const currentStroke = pageStrokeForShape(editor, shape);
    return currentStroke !== null && strokesMatch(currentStroke, selection.strokes[index]);
  });
}

export async function recognizeMathInk(
  strokes: MathInkStroke[],
  options: {
    token?: string;
    signal?: AbortSignal;
    fetcher?: typeof fetch;
  } = {},
): Promise<MathInkRecognition> {
  const response = await (options.fetcher ?? fetch)(MATHINK_RECOGNIZE_PATH, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    },
    body: JSON.stringify({ strokes }),
    signal: options.signal,
  });

  if (!response.ok) {
    if (response.status === 429) {
      throw new Error("MathInk is receiving too many requests. Wait a moment and try again.");
    }
    if (response.status === 413 || response.status === 422) {
      throw new Error("MathInk could not process that selection. Try a smaller expression.");
    }
    throw new Error("MathInk is temporarily unavailable. Try again in a moment.");
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error("MathInk returned an unreadable response.");
  }
  const parsed = v.safeParse(mathInkRecognitionResponseSchema, payload);
  if (!parsed.success) {
    throw new Error("MathInk returned an unreadable response.");
  }

  return {
    latex: parsed.output.latex.trim(),
    modelStep: parsed.output.model_step,
    latencyMs: parsed.output.latency_ms,
  };
}

/** Complete only unclosed trailing groups when that exact edit makes KaTeX valid. */
export function repairIncompleteMathInkLatex(latex: string): MathInkLatexRepair {
  const trimmed = latex.trim();
  if (!trimmed || getKatexError(trimmed) === null) {
    return { latex: trimmed, repaired: false };
  }

  let balance = 0;
  let consecutiveBackslashes = 0;
  for (const character of trimmed) {
    if (character === "\\") {
      consecutiveBackslashes += 1;
      continue;
    }

    const isEscaped = consecutiveBackslashes % 2 === 1;
    consecutiveBackslashes = 0;
    if (!isEscaped && character === "{") balance += 1;
    if (!isEscaped && character === "}") {
      balance -= 1;
      if (balance < 0) return { latex: trimmed, repaired: false };
    }
  }

  if (balance < 1 || balance > 16) return { latex: trimmed, repaired: false };
  const candidate = `${trimmed}${"}".repeat(balance)}`;
  return getKatexError(candidate) === null
    ? { latex: candidate, repaired: true }
    : { latex: trimmed, repaired: false };
}

/** Prefix plain-leading LaTeX so reopening the existing math editor stays in LaTeX mode. */
export function mathInkInputFromLatex(latex: string): string {
  const trimmed = latex.trim();
  // A no-op command selects LaTeX input without forcing display styling when
  // the shape is later switched to Inline or reopened for editing.
  const input = trimmed.startsWith("\\") ? trimmed : `\\relax ${trimmed}`;
  if (input.length > MAX_MATH_INPUT_LENGTH) {
    throw new Error("That recognized expression is too long to place on the whiteboard.");
  }
  return input;
}

export function placeMathInkRecognition(
  editor: Editor,
  selection: MathInkSelection,
  latex: string,
  placement: "replace" | "beside",
): TLShapeId {
  if (!isMathInkSelectionCurrent(editor, selection)) {
    throw new Error("The selected handwriting changed. Run MathInk again before placing it.");
  }

  const input = mathInkInputFromLatex(latex);
  const parentId = selection.parentId;
  if (isShapeId(parentId) && !editor.getShape(parentId)) {
    throw new Error("The selected handwriting changed. Run MathInk again before placing it.");
  }

  const centerPage = {
    x:
      placement === "beside"
        ? selection.bounds.maxX + INSERT_GAP + DEFAULT_MATH_WIDTH / 2
        : (selection.bounds.minX + selection.bounds.maxX) / 2,
    y: (selection.bounds.minY + selection.bounds.maxY) / 2,
  };
  const centerInParent = isShapeId(parentId)
    ? editor.getShapePageTransform(parentId).clone().invert().applyToPoint(centerPage)
    : centerPage;

  const id = createShapeId();
  editor.markHistoryStoppingPoint("convert handwriting to math");
  editor.run(() => {
    editor.createShape({
      id,
      type: MATH_SHAPE_TYPE,
      parentId,
      x: centerInParent.x - DEFAULT_MATH_WIDTH / 2,
      y: centerInParent.y - DEFAULT_MATH_HEIGHT / 2,
      props: createMathShapeProps({
        input,
        latex: latex.trim(),
        displayMode: true,
      }),
    });

    if (placement === "replace") editor.deleteShapes(selection.shapeIds);
    editor.setCurrentTool("select");
    editor.setSelectedShapes([id]);
  });
  return id;
}
