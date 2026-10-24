import {
  b64Vecs,
  Box,
  getDisplayValues,
  renderPlaintextFromRichText,
  toRichText,
  Vec,
  type Editor,
  type TLArrowBinding,
  type TLArrowShape,
  type TLDefaultFillStyle,
  type TLDefaultSizeStyle,
  type TLDrawShape,
  type TLGeoShape,
  type TLGeoShapeGeoStyle,
  type TLLineShape,
  type TLNoteShape,
  type TLShape,
  type TLShapeId,
  type TLTextShape,
  type TextShapeUtil,
  type TextShapeUtilDisplayValues,
  type VecLike,
  type VecModel,
} from "tldraw";
import {
  CANVAS_COLORS,
  type CanvasColor,
  type CanvasFill,
  type CanvasShape,
  type GeoKind,
  type NewArrowShape,
  type NewDrawShape,
  type NewShape,
  type NewTextShape,
  type ShapeUpdate,
  type TextAnchor,
} from "@orbmeet/whiteboard-core/assistant";
import { isPageFrameShape, type PageFrameShape } from "@orbmeet/whiteboard-core/page-frame-model";
import { getDrawableShapeEntries, getFrameExportContent } from "../pages/export-page-membership";

// Conversion between tldraw records and the assistant's shape format.
// Adapted from tldraw's agent starter kit (shared/format), with two changes:
// coordinates are relative to one page frame, and new shapes are that frame's
// children, so "x: 0, y: 0" is the page's top-left corner.

const GEO_TO_TLDRAW: Record<GeoKind, TLGeoShapeGeoStyle> = {
  rectangle: "rectangle",
  ellipse: "ellipse",
  triangle: "triangle",
  diamond: "diamond",
  hexagon: "hexagon",
  pentagon: "pentagon",
  octagon: "octagon",
  star: "star",
  pill: "oval",
  cloud: "cloud",
  heart: "heart",
  "x-box": "x-box",
  "check-box": "check-box",
  trapezoid: "trapezoid",
  "parallelogram-right": "rhombus",
  "parallelogram-left": "rhombus-2",
  "fat-arrow-right": "arrow-right",
  "fat-arrow-left": "arrow-left",
  "fat-arrow-up": "arrow-up",
  "fat-arrow-down": "arrow-down",
};
const TLDRAW_TO_GEO = Object.fromEntries(
  Object.entries(GEO_TO_TLDRAW).map(([kind, geo]) => [geo, kind]),
) as Record<TLGeoShapeGeoStyle, GeoKind>;

const FILL_TO_TLDRAW: Record<CanvasFill, TLDefaultFillStyle> = {
  none: "none",
  tint: "solid",
  background: "semi",
  solid: "lined-fill",
  pattern: "pattern",
};
const TLDRAW_TO_FILL: Record<TLDefaultFillStyle, CanvasFill> = {
  none: "none",
  solid: "tint",
  semi: "background",
  fill: "solid",
  "lined-fill": "solid",
  pattern: "pattern",
};

const TEXT_SIZES = ["s", "m", "l", "xl"] as const satisfies readonly TLDefaultSizeStyle[];

/** The page the assistant is working on, and where its origin sits on the canvas. */
export interface AssistantPage {
  frame: PageFrameShape;
  origin: Vec;
}

export function resolveAssistantPage(editor: Editor, pageId: string): AssistantPage | null {
  const frame = editor.getShape(pageId as TLShapeId);
  if (!frame || !isPageFrameShape(frame)) return null;
  return { frame, origin: new Vec(frame.x, frame.y) };
}

/** Every shape that shows on the page, by the same rule the PDF export uses. */
export function pageShapeIds(editor: Editor, page: AssistantPage): TLShapeId[] {
  const bounds = new Box(page.frame.x, page.frame.y, page.frame.props.w, page.frame.props.h);
  const top = getFrameExportContent(editor, page.frame.id, bounds, getDrawableShapeEntries(editor)).shapeIds;
  const ids: TLShapeId[] = [];
  const visit = (id: TLShapeId) => {
    ids.push(id);
    for (const child of editor.getSortedChildIdsForParent(id)) visit(child);
  };
  for (const id of top) visit(id);
  return ids;
}

export function toSimpleId(id: TLShapeId): string {
  return id.slice("shape:".length);
}

function toTldrawId(id: string): TLShapeId {
  return `shape:${id}` as TLShapeId;
}

// ─── Reading ────────────────────────────────────────────────────────────────

export function readPageShapes(editor: Editor, page: AssistantPage): CanvasShape[] {
  return pageShapeIds(editor, page)
    .map((id) => editor.getShape(id))
    .filter((shape): shape is TLShape => !!shape && shape.type !== "group")
    .map((shape) => toCanvasShape(editor, page, shape));
}

function toCanvasShape(editor: Editor, page: AssistantPage, shape: TLShape): CanvasShape {
  const bounds = editor.getShapePageBounds(shape) ?? new Box(shape.x, shape.y, 0, 0);
  const x = round(bounds.x - page.origin.x);
  const y = round(bounds.y - page.origin.y);
  const w = round(bounds.w);
  const h = round(bounds.h);
  const shapeId = toSimpleId(shape.id);
  const note = typeof shape.meta.note === "string" && shape.meta.note ? shape.meta.note : undefined;
  const text = shapeText(editor, shape);

  switch (shape.type) {
    case "geo": {
      const geo = shape;
      return {
        _type: TLDRAW_TO_GEO[geo.props.geo],
        shapeId, x, y, w, h,
        ...(text ? { text } : {}),
        color: asColor(geo.props.color),
        fill: TLDRAW_TO_FILL[geo.props.fill],
        note,
      };
    }
    case "text": {
      const textShape = shape;
      return {
        _type: "text",
        shapeId, x, y, w, h,
        text: text ?? "",
        color: asColor(textShape.props.color),
        fontSize: textFontSize(editor, textShape),
        note,
      };
    }
    case "note":
      return { _type: "note", shapeId, x, y, w, h, ...(text ? { text } : {}), color: asColor((shape).props.color), note };
    case "arrow": {
      const arrow = shape;
      const start = pageToLocal(page, editor.getShapePageTransform(arrow).applyToPoint(arrow.props.start));
      const end = pageToLocal(page, editor.getShapePageTransform(arrow).applyToPoint(arrow.props.end));
      const bindings = editor.getBindingsFromShape<TLArrowBinding>(arrow, "arrow");
      const fromId = bindings.find((binding) => binding.props.terminal === "start")?.toId;
      const toId = bindings.find((binding) => binding.props.terminal === "end")?.toId;
      return {
        _type: "arrow",
        shapeId,
        x1: round(start.x), y1: round(start.y), x2: round(end.x), y2: round(end.y),
        ...(fromId ? { fromId: toSimpleId(fromId) } : {}),
        ...(toId ? { toId: toSimpleId(toId) } : {}),
        ...(text ? { text } : {}),
        // tldraw bends the other way round from the convention the model is told.
        bend: round(-arrow.props.bend),
        color: asColor(arrow.props.color),
        note,
      };
    }
    case "line": {
      const line = shape;
      const points = Object.values(line.props.points).sort((a, b) => (a.index < b.index ? -1 : 1));
      const transform = editor.getShapePageTransform(line);
      const first = pageToLocal(page, transform.applyToPoint(points[0] ?? { x: 0, y: 0 }));
      const last = pageToLocal(page, transform.applyToPoint(points.at(-1) ?? { x: 0, y: 0 }));
      return {
        _type: "line",
        shapeId,
        x1: round(first.x), y1: round(first.y), x2: round(last.x), y2: round(last.y),
        color: asColor(line.props.color),
        note,
      };
    }
    case "draw": {
      const draw = shape;
      return { _type: "draw", shapeId, x, y, w, h, color: asColor(draw.props.color), fill: TLDRAW_TO_FILL[draw.props.fill], note };
    }
    default:
      return { _type: "other", kind: shape.type, shapeId, x, y, w, h, ...(text ? { text } : {}), note };
  }
}

function shapeText(editor: Editor, shape: TLShape): string | undefined {
  const props = shape.props as { richText?: Parameters<typeof renderPlaintextFromRichText>[1] };
  if (props.richText) return renderPlaintextFromRichText(editor, props.richText) || undefined;
  return editor.getShapeUtil(shape).getText(shape) || undefined;
}

// ─── Writing ────────────────────────────────────────────────────────────────

/**
 * Create one shape on the page. Returns the id it was created with, which
 * differs from the requested one when that id is already taken.
 */
export function createCanvasShape(
  editor: Editor,
  page: AssistantPage,
  shape: NewShape,
  idMap: Map<string, string>,
): string {
  const id = uniqueShapeId(editor, shape.shapeId);
  idMap.set(shape.shapeId, id);
  const tlId = toTldrawId(id);
  const base = {
    id: tlId,
    parentId: page.frame.id,
    meta: shape.note ? { note: shape.note } : {},
  };

  switch (shape._type) {
    case "text":
      editor.createShape<TLTextShape>({
        ...base,
        type: "text",
        x: shape.x,
        y: shape.y,
        props: textProps(editor, shape),
      });
      placeText(editor, page, tlId, shape.x, shape.y, shape.anchor ?? "top-left");
      break;
    case "note":
      editor.createShape<TLNoteShape>({
        ...base,
        type: "note",
        x: shape.x,
        y: shape.y,
        props: { richText: toRichText(shape.text ?? ""), color: shape.color ?? "yellow" },
      });
      break;
    case "arrow":
      createArrow(editor, page, base, shape, idMap);
      break;
    case "line": {
      const minX = Math.min(shape.x1, shape.x2);
      const minY = Math.min(shape.y1, shape.y2);
      editor.createShape<TLLineShape>({
        ...base,
        type: "line",
        x: minX,
        y: minY,
        props: {
          color: shape.color ?? "black",
          points: {
            a1: { id: "a1", index: "a1" as never, x: shape.x1 - minX, y: shape.y1 - minY },
            a2: { id: "a2", index: "a2" as never, x: shape.x2 - minX, y: shape.y2 - minY },
          },
        },
      });
      break;
    }
    case "draw":
      createStroke(editor, base, shape);
      break;
    default:
      editor.createShape<TLGeoShape>({
        ...base,
        type: "geo",
        x: shape.x,
        y: shape.y,
        props: {
          geo: GEO_TO_TLDRAW[shape._type],
          w: shape.w,
          h: shape.h,
          richText: toRichText(shape.text ?? ""),
          align: shape.textAlign ?? "middle",
          color: shape.color ?? "black",
          fill: FILL_TO_TLDRAW[shape.fill ?? "none"],
        },
      });
  }
  if (!editor.getShape(tlId)) throw new Error(`${shape.shapeId} could not be created`);
  return id;
}

export function updateCanvasShape(
  editor: Editor,
  page: AssistantPage,
  allowed: ReadonlySet<TLShapeId>,
  update: ShapeUpdate,
): void {
  const id = toTldrawId(update.shapeId);
  const shape = editor.getShape(id);
  if (!shape || !allowed.has(id)) throw new Error(`${update.shapeId} is not on this page`);

  const meta = update.note === undefined ? {} : { meta: { ...shape.meta, note: update.note } };

  switch (shape.type) {
    case "geo":
      editor.updateShape<TLGeoShape>({
        id,
        type: "geo",
        ...positionUpdate(editor, page, shape, update),
        ...meta,
        props: definedProps({
          w: update.w,
          h: update.h,
          richText: update.text === undefined ? undefined : toRichText(update.text),
          align: update.textAlign,
          color: update.color,
          fill: update.fill === undefined ? undefined : FILL_TO_TLDRAW[update.fill],
        }),
      });
      return;
    case "text": {
      const text = shape;
      const next = textProps(editor, {
        text: update.text ?? renderPlaintextFromRichText(editor, text.props.richText),
        anchor: update.anchor,
        fontSize: update.fontSize ?? textFontSize(editor, text),
        maxWidth: update.maxWidth ?? (text.props.autoSize ? undefined : text.props.w),
        color: update.color ?? asColor(text.props.color),
      });
      editor.updateShape<TLTextShape>({ id, type: "text", ...meta, props: next });
      if (update.x !== undefined || update.y !== undefined || update.anchor !== undefined) {
        const current = toCanvasShape(editor, page, editor.getShape(id)!);
        const anchor = update.anchor ?? alignmentAnchor(next.textAlign);
        const point = anchorPoint(current as { x: number; y: number; w: number; h: number }, anchor);
        placeText(editor, page, id, update.x ?? point.x, update.y ?? point.y, anchor);
      }
      return;
    }
    case "note":
      editor.updateShape<TLNoteShape>({
        id,
        type: "note",
        ...positionUpdate(editor, page, shape, update),
        ...meta,
        props: definedProps({
          richText: update.text === undefined ? undefined : toRichText(update.text),
          color: update.color,
        }),
      });
      return;
    case "arrow": {
      const current = toCanvasShape(editor, page, shape) as Extract<CanvasShape, { _type: "arrow" }>;
      const next: NewArrowShape = {
        _type: "arrow",
        shapeId: update.shapeId,
        x1: update.x1 ?? current.x1,
        y1: update.y1 ?? current.y1,
        x2: update.x2 ?? current.x2,
        y2: update.y2 ?? current.y2,
        fromId: update.fromId ?? current.fromId,
        toId: update.toId ?? current.toId,
        text: update.text ?? current.text,
        bend: update.bend ?? current.bend,
        color: update.color ?? current.color,
      };
      const { x, y, props } = arrowGeometry(next);
      const parentPoint = editor.getPointInParentSpace(shape, localToPage(page, { x, y }));
      editor.updateShape<TLArrowShape>({ id, type: "arrow", x: parentPoint.x, y: parentPoint.y, ...meta, props });
      editor.deleteBindings(editor.getBindingsFromShape(shape, "arrow"));
      bindArrow(editor, page, id, next, new Map());
      return;
    }
    case "line": {
      const current = toCanvasShape(editor, page, shape) as Extract<CanvasShape, { _type: "line" }>;
      const x1 = update.x1 ?? current.x1;
      const y1 = update.y1 ?? current.y1;
      const x2 = update.x2 ?? current.x2;
      const y2 = update.y2 ?? current.y2;
      const minX = Math.min(x1, x2);
      const minY = Math.min(y1, y2);
      const parentPoint = editor.getPointInParentSpace(shape, localToPage(page, { x: minX, y: minY }));
      editor.updateShape<TLLineShape>({
        id,
        type: "line",
        x: parentPoint.x,
        y: parentPoint.y,
        ...meta,
        props: definedProps({
          color: update.color,
          points: {
            a1: { id: "a1", index: "a1" as never, x: x1 - minX, y: y1 - minY },
            a2: { id: "a2", index: "a2" as never, x: x2 - minX, y: y2 - minY },
          },
        }),
      });
      return;
    }
    case "draw":
      editor.updateShape<TLDrawShape>({
        id,
        type: "draw",
        ...positionUpdate(editor, page, shape, update),
        ...meta,
        props: definedProps({
          color: update.color,
          fill: update.fill === undefined ? undefined : FILL_TO_TLDRAW[update.fill],
        }),
      });
      return;
    default:
      // Images, math, code and the like: the assistant may move them, nothing more.
      editor.updateShape({ id, type: shape.type, ...positionUpdate(editor, page, shape, update), ...meta });
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function createArrow(
  editor: Editor,
  page: AssistantPage,
  base: { id: TLShapeId; parentId: TLShapeId; meta: TLShape["meta"] },
  arrow: NewArrowShape,
  idMap: ReadonlyMap<string, string>,
): void {
  const { x, y, props } = arrowGeometry(arrow);
  editor.createShape<TLArrowShape>({ ...base, type: "arrow", x, y, props });
  bindArrow(editor, page, base.id, arrow, idMap);
}

function arrowGeometry(arrow: NewArrowShape): { x: number; y: number; props: Partial<TLArrowShape["props"]> } {
  const x = Math.min(arrow.x1, arrow.x2);
  const y = Math.min(arrow.y1, arrow.y2);
  return {
    x,
    y,
    props: {
      start: { x: arrow.x1 - x, y: arrow.y1 - y },
      end: { x: arrow.x2 - x, y: arrow.y2 - y },
      // tldraw bends the other way round from the convention the model is told.
      bend: -(arrow.bend ?? 0),
      color: arrow.color ?? "black",
      richText: toRichText(arrow.text ?? ""),
    },
  };
}

/** Attach the arrow's ends to the shapes it names, at the points it was drawn to. */
function bindArrow(
  editor: Editor,
  page: AssistantPage,
  arrowId: TLShapeId,
  arrow: NewArrowShape,
  idMap: ReadonlyMap<string, string>,
): void {
  for (const [terminal, targetId, point] of [
    ["start", arrow.fromId, { x: arrow.x1, y: arrow.y1 }],
    ["end", arrow.toId, { x: arrow.x2, y: arrow.y2 }],
  ] as const) {
    if (!targetId) continue;
    const target = editor.getShape(toTldrawId(idMap.get(targetId) ?? targetId));
    if (!target || target.id === arrowId) continue;
    editor.createBinding<TLArrowBinding>({
      type: "arrow",
      fromId: arrowId,
      toId: target.id,
      props: {
        terminal,
        normalizedAnchor: bindingAnchor(editor, target, localToPage(page, point)),
        isExact: false,
        isPrecise: true,
      },
    });
  }
}

/** Where on `target` an arrow end at `point` should attach, normalised to its bounds. */
function bindingAnchor(editor: Editor, target: TLShape, point: VecLike): VecModel {
  const bounds = editor.getShapePageBounds(target);
  const geometry = editor.getShapeGeometry(target);
  if (!bounds || !geometry || bounds.w === 0 || bounds.h === 0) return { x: 0.5, y: 0.5 };
  const pageGeometry = geometry.transform(editor.getShapePageTransform(target));
  const anchor = pageGeometry.hitTestPoint(point, 0, true) ? point : pageGeometry.nearestPoint(point);
  const clamped = {
    x: Math.max(0.1, Math.min(0.9, (anchor.x - bounds.x) / bounds.w)),
    y: Math.max(0.1, Math.min(0.9, (anchor.y - bounds.y) / bounds.h)),
  };
  const clampedPoint = { x: bounds.x + clamped.x * bounds.w, y: bounds.y + clamped.y * bounds.h };
  return pageGeometry.hitTestPoint(clampedPoint, 0, true) ? clamped : { x: 0.5, y: 0.5 };
}

/** Densify a polyline so tldraw's freehand renderer draws straight runs straight. */
function createStroke(
  editor: Editor,
  base: { id: TLShapeId; parentId: TLShapeId; meta: TLShape["meta"] },
  stroke: NewDrawShape,
): void {
  const points: VecModel[] = stroke.closed ? [...stroke.points, stroke.points[0]] : [...stroke.points];
  const dense: VecModel[] = [];
  for (let index = 0; index < points.length; index++) {
    const point = points[index];
    dense.push(point);
    const next = points[index + 1];
    if (!next) continue;
    const steps = Math.min(200, Math.floor(Vec.Dist(point, next) / 4));
    for (let step = 1; step <= steps; step++) dense.push(Vec.Lrp(point, next, step / (steps + 1)));
  }
  const minX = Math.min(...dense.map((point) => point.x));
  const minY = Math.min(...dense.map((point) => point.y));
  editor.createShape<TLDrawShape>({
    ...base,
    type: "draw",
    x: minX,
    y: minY,
    props: {
      color: stroke.color ?? "black",
      fill: FILL_TO_TLDRAW[stroke.fill ?? "none"],
      size: "s",
      segments: [
        { type: "free", path: b64Vecs.encodePoints2D(dense.map((point) => ({ x: point.x - minX, y: point.y - minY }))), dim: 2 },
      ],
      isComplete: true,
      isClosed: !!stroke.closed,
      isPen: false,
    },
  });
}

function textProps(
  editor: Editor,
  shape: Pick<NewTextShape, "text" | "anchor" | "fontSize" | "maxWidth" | "color">,
): Partial<TLTextShape["props"]> {
  const { size, scale } = textSizeFor(editor, shape.fontSize ?? 26);
  return {
    richText: toRichText(shape.text),
    color: shape.color ?? "black",
    size,
    scale,
    textAlign: textAlignFor(shape.anchor ?? "top-left"),
    autoSize: shape.maxWidth === undefined,
    ...(shape.maxWidth === undefined ? {} : { w: shape.maxWidth }),
  };
}

/** The tldraw size and scale whose rendered height is closest to `fontSize`. */
function textSizeFor(editor: Editor, fontSize: number): { size: TLDefaultSizeStyle; scale: number } {
  let best: { size: TLDefaultSizeStyle; pixels: number } = { size: "s", pixels: textSizePixels(editor, "s") };
  for (const size of TEXT_SIZES) {
    const pixels = textSizePixels(editor, size);
    if (Math.abs(pixels - fontSize) < Math.abs(best.pixels - fontSize)) best = { size, pixels };
  }
  return { size: best.size, scale: fontSize / best.pixels };
}

function textSizePixels(editor: Editor, size: TLDefaultSizeStyle): number {
  const util = editor.getShapeUtil<TextShapeUtil>("text");
  const probe = { type: "text", props: { ...util.getDefaultProps(), size } } as TLTextShape;
  return getDisplayValues<TLTextShape, TextShapeUtilDisplayValues>(util, probe).fontSize;
}

function textFontSize(editor: Editor, shape: TLTextShape): number {
  const util = editor.getShapeUtil<TextShapeUtil>("text");
  return round(getDisplayValues<TLTextShape, TextShapeUtilDisplayValues>(util, shape).fontSize * shape.props.scale);
}

function textAlignFor(anchor: TextAnchor): TLTextShape["props"]["textAlign"] {
  if (anchor.endsWith("left")) return "start";
  if (anchor.endsWith("right")) return "end";
  return "middle";
}

function alignmentAnchor(align: TLTextShape["props"]["textAlign"] | undefined): TextAnchor {
  return align === "middle" ? "top-center" : align === "end" ? "top-right" : "top-left";
}

/** Move a text shape so the point `anchor` names lands on (x, y). Needs its rendered size. */
function placeText(editor: Editor, page: AssistantPage, id: TLShapeId, x: number, y: number, anchor: TextAnchor): void {
  const shape = editor.getShape(id);
  const bounds = shape && editor.getShapePageBounds(shape);
  if (!shape || !bounds) return;
  const horizontal = anchor.endsWith("left") ? 0 : anchor.endsWith("right") ? 1 : 0.5;
  const vertical = anchor.startsWith("top") ? 0 : anchor.startsWith("bottom") ? 1 : 0.5;
  const topLeft = localToPage(page, { x: x - bounds.w * horizontal, y: y - bounds.h * vertical });
  const parentPoint = editor.getPointInParentSpace(shape, topLeft);
  editor.updateShape({ id, type: "text", x: parentPoint.x, y: parentPoint.y });
}

function anchorPoint(box: { x: number; y: number; w: number; h: number }, anchor: TextAnchor): VecModel {
  const horizontal = anchor.endsWith("left") ? 0 : anchor.endsWith("right") ? 1 : 0.5;
  const vertical = anchor.startsWith("top") ? 0 : anchor.startsWith("bottom") ? 1 : 0.5;
  return { x: box.x + box.w * horizontal, y: box.y + box.h * vertical };
}

/** x/y name the shape's top-left on the page; the record wants its parent's space. */
function positionUpdate(editor: Editor, page: AssistantPage, shape: TLShape, update: ShapeUpdate): { x?: number; y?: number } {
  if (update.x === undefined && update.y === undefined) return {};
  const bounds = editor.getShapePageBounds(shape);
  if (!bounds) return {};
  // Shift by the bounds' move so a rotated or offset shape keeps its geometry.
  const target = localToPage(page, {
    x: update.x ?? bounds.x - page.origin.x,
    y: update.y ?? bounds.y - page.origin.y,
  });
  const pagePoint = editor.getShapePageTransform(shape).applyToPoint({ x: 0, y: 0 });
  const moved = { x: pagePoint.x + target.x - bounds.x, y: pagePoint.y + target.y - bounds.y };
  const parentPoint = editor.getPointInParentSpace(shape, moved);
  return { x: parentPoint.x, y: parentPoint.y };
}

function uniqueShapeId(editor: Editor, requested: string): string {
  let id = requested;
  for (let suffix = 2; editor.getShape(toTldrawId(id)); suffix++) id = `${requested}-${suffix}`;
  return id;
}

function definedProps<T extends Record<string, unknown>>(props: T): Partial<T> {
  return Object.fromEntries(Object.entries(props).filter(([, value]) => value !== undefined)) as Partial<T>;
}

function localToPage(page: AssistantPage, point: VecLike): Vec {
  return new Vec(point.x + page.origin.x, point.y + page.origin.y);
}

function pageToLocal(page: AssistantPage, point: VecLike): Vec {
  return new Vec(point.x - page.origin.x, point.y - page.origin.y);
}

function asColor(color: string): CanvasColor {
  return (CANVAS_COLORS as readonly string[]).includes(color) ? (color as CanvasColor) : "black";
}

function round(value: number): number {
  return Math.round(value);
}
