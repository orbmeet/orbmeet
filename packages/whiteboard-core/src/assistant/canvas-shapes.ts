import * as v from "valibot";

// The shape vocabulary the assistant draws with. It is deliberately smaller
// and flatter than tldraw's records: plain string ids, a `_type` per visible
// kind, and coordinates relative to the top-left corner of the page the
// request came from (a page is a frame shape, and its children use exactly
// these local coordinates). Adapted from tldraw's agent starter kit format.

export const CANVAS_COLORS = [
  "black",
  "grey",
  "white",
  "red",
  "light-red",
  "orange",
  "yellow",
  "green",
  "light-green",
  "blue",
  "light-blue",
  "violet",
  "light-violet",
] as const;
export type CanvasColor = (typeof CANVAS_COLORS)[number];

/** `background` fills with the canvas colour; `tint` is a light wash of `color`. */
export const CANVAS_FILLS = ["none", "tint", "background", "solid", "pattern"] as const;
export type CanvasFill = (typeof CANVAS_FILLS)[number];

export const GEO_KINDS = [
  "rectangle",
  "ellipse",
  "triangle",
  "diamond",
  "hexagon",
  "pentagon",
  "octagon",
  "star",
  "pill",
  "cloud",
  "heart",
  "x-box",
  "check-box",
  "trapezoid",
  "parallelogram-right",
  "parallelogram-left",
  "fat-arrow-right",
  "fat-arrow-left",
  "fat-arrow-up",
  "fat-arrow-down",
] as const;
export type GeoKind = (typeof GEO_KINDS)[number];

export const TEXT_ANCHORS = [
  "top-left",
  "top-center",
  "top-right",
  "center-left",
  "center",
  "center-right",
  "bottom-left",
  "bottom-center",
  "bottom-right",
] as const;
export type TextAnchor = (typeof TEXT_ANCHORS)[number];

export const MAX_SHAPE_TEXT_LENGTH = 2_000;
const MAX_NOTE_LENGTH = 300;
/** Keeps a confused model from placing shapes light-years off the page. */
const MAX_COORDINATE = 100_000;
const MAX_SIZE = 20_000;
export const MAX_PATH_POINTS = 300;

export const ShapeIdSchema = v.pipe(
  v.string(),
  v.regex(/^[A-Za-z0-9_-]{1,64}$/, "Shape ids are 1-64 letters, digits, '_' or '-'"),
  v.description("Your id for the shape, e.g. 'step-1'. Unique on the page."),
);

const coordinate = v.pipe(v.number(), v.minValue(-MAX_COORDINATE), v.maxValue(MAX_COORDINATE));
const size = v.pipe(v.number(), v.minValue(1), v.maxValue(MAX_SIZE));
const text = v.pipe(v.string(), v.maxLength(MAX_SHAPE_TEXT_LENGTH));
const color = v.optional(v.picklist(CANVAS_COLORS));
const fill = v.optional(v.picklist(CANVAS_FILLS));
const note = v.optional(
  v.pipe(
    v.string(),
    v.maxLength(MAX_NOTE_LENGTH),
    v.description("Why the shape exists, for your own later reference. Never shown to people."),
  ),
);

const GeoShapeSchema = v.object({
  _type: v.picklist(GEO_KINDS),
  shapeId: ShapeIdSchema,
  x: v.pipe(coordinate, v.description("Left edge.")),
  y: v.pipe(coordinate, v.description("Top edge.")),
  w: size,
  h: size,
  text: v.optional(v.pipe(text, v.description("Label drawn inside the shape."))),
  textAlign: v.optional(v.picklist(["start", "middle", "end"])),
  color,
  fill,
  note,
});

const TextShapeSchema = v.object({
  _type: v.literal("text"),
  shapeId: ShapeIdSchema,
  x: coordinate,
  y: coordinate,
  anchor: v.optional(
    v.pipe(
      v.picklist(TEXT_ANCHORS),
      v.description(
        "Which point of the text x/y names; it also sets alignment. 'top-left' (the default) is left-aligned from that corner, 'center' centres the text on x/y.",
      ),
    ),
  ),
  text,
  fontSize: v.optional(
    v.pipe(v.number(), v.minValue(8), v.maxValue(400), v.description("Text height in pixels. Default 26.")),
  ),
  maxWidth: v.optional(
    v.pipe(size, v.description("Wrap the text at this width. Without it, text grows to fit on one line.")),
  ),
  color,
  note,
});

const NoteShapeSchema = v.object({
  _type: v.literal("note"),
  shapeId: ShapeIdSchema,
  x: coordinate,
  y: coordinate,
  text: v.optional(text),
  color,
  note,
});

const ArrowShapeSchema = v.object({
  _type: v.literal("arrow"),
  shapeId: ShapeIdSchema,
  x1: coordinate,
  y1: coordinate,
  x2: coordinate,
  y2: coordinate,
  fromId: v.optional(v.pipe(ShapeIdSchema, v.description("Shape the arrow starts from; it stays attached when that shape moves."))),
  toId: v.optional(v.pipe(ShapeIdSchema, v.description("Shape the arrow points to; it stays attached when that shape moves."))),
  text: v.optional(v.pipe(text, v.description("Label on the arrow."))),
  bend: v.optional(
    v.pipe(
      v.number(),
      v.minValue(-MAX_SIZE),
      v.maxValue(MAX_SIZE),
      v.description("Pixels the midpoint bows out. Positive bows to the left of the direction of travel."),
    ),
  ),
  color,
  note,
});

const LineShapeSchema = v.object({
  _type: v.literal("line"),
  shapeId: ShapeIdSchema,
  x1: coordinate,
  y1: coordinate,
  x2: coordinate,
  y2: coordinate,
  color,
  note,
});

const DrawShapeSchema = v.object({
  _type: v.literal("draw"),
  shapeId: ShapeIdSchema,
  points: v.pipe(
    v.array(v.object({ x: coordinate, y: coordinate })),
    v.minLength(2),
    v.maxLength(MAX_PATH_POINTS),
    v.description("A freehand pen stroke through these points, in order. Use for anything the other shapes cannot express."),
  ),
  closed: v.optional(v.pipe(v.boolean(), v.description("Join the last point back to the first."))),
  color,
  fill,
  note,
});

/** A shape the assistant asks to create. */
export const NewShapeSchema = v.variant("_type", [
  GeoShapeSchema,
  TextShapeSchema,
  NoteShapeSchema,
  ArrowShapeSchema,
  LineShapeSchema,
  DrawShapeSchema,
]);
export type NewShape = v.InferOutput<typeof NewShapeSchema>;
export type NewGeoShape = v.InferOutput<typeof GeoShapeSchema>;
export type NewTextShape = v.InferOutput<typeof TextShapeSchema>;
export type NewNoteShape = v.InferOutput<typeof NoteShapeSchema>;
export type NewArrowShape = v.InferOutput<typeof ArrowShapeSchema>;
export type NewLineShape = v.InferOutput<typeof LineShapeSchema>;
export type NewDrawShape = v.InferOutput<typeof DrawShapeSchema>;

/**
 * A change to one existing shape. Only the fields given change; a field that
 * does not apply to the shape's kind is ignored.
 */
export const ShapeUpdateSchema = v.object({
  shapeId: ShapeIdSchema,
  x: v.optional(coordinate),
  y: v.optional(coordinate),
  w: v.optional(size),
  h: v.optional(size),
  x1: v.optional(coordinate),
  y1: v.optional(coordinate),
  x2: v.optional(coordinate),
  y2: v.optional(coordinate),
  text: v.optional(text),
  textAlign: v.optional(v.picklist(["start", "middle", "end"])),
  anchor: v.optional(v.picklist(TEXT_ANCHORS)),
  fontSize: v.optional(v.pipe(v.number(), v.minValue(8), v.maxValue(400))),
  maxWidth: v.optional(size),
  fromId: v.optional(ShapeIdSchema),
  toId: v.optional(ShapeIdSchema),
  bend: v.optional(v.pipe(v.number(), v.minValue(-MAX_SIZE), v.maxValue(MAX_SIZE))),
  color,
  fill,
  note,
});
export type ShapeUpdate = v.InferOutput<typeof ShapeUpdateSchema>;

// ─── What the assistant reads back ────────────────────────────────────────────
// Produced by the client from live tldraw records; never parsed from the model.

interface ShapeBase {
  shapeId: string;
  note?: string;
}

export type CanvasShape =
  | (ShapeBase & {
      _type: GeoKind;
      x: number;
      y: number;
      w: number;
      h: number;
      text?: string;
      color: CanvasColor;
      fill: CanvasFill;
    })
  | (ShapeBase & {
      _type: "text";
      x: number;
      y: number;
      w: number;
      h: number;
      text: string;
      color: CanvasColor;
      fontSize: number;
    })
  | (ShapeBase & { _type: "note"; x: number; y: number; w: number; h: number; text?: string; color: CanvasColor })
  | (ShapeBase & {
      _type: "arrow";
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      fromId?: string;
      toId?: string;
      text?: string;
      bend: number;
      color: CanvasColor;
    })
  | (ShapeBase & { _type: "line"; x1: number; y1: number; x2: number; y2: number; color: CanvasColor })
  | (ShapeBase & { _type: "draw"; x: number; y: number; w: number; h: number; color: CanvasColor; fill: CanvasFill })
  | (ShapeBase & {
      /** Anything else on the board (images, math, code, …): visible, movable, not editable. */
      _type: "other";
      kind: string;
      x: number;
      y: number;
      w: number;
      h: number;
      text?: string;
    });
