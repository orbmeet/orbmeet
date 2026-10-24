import * as v from "valibot";
import { NewShapeSchema, ShapeIdSchema, ShapeUpdateSchema } from "./canvas-shapes.ts";

// The tools that act on the board. The sync server offers them to the model;
// the requester's browser carries them out with tldraw's Editor, which is the
// only place a shape's geometry, text size and arrow bindings can be computed.

const MAX_SHAPES_PER_CALL = 60;

export const CANVAS_TOOLS = {
  view_page: {
    label: "Looking at the page",
    edits: false,
    description:
      "Look at the page as it is now: a screenshot plus every shape on it. Use it to check your work after drawing something non-trivial, then fix overlaps, cut-off text or loose arrows.",
    args: v.object({}),
  },
  create_shapes: {
    label: "Drawing",
    edits: true,
    description:
      "Add shapes to the page. Shapes are created in order, so arrows may refer to shapes created earlier in the same call.",
    args: v.object({
      shapes: v.pipe(v.array(NewShapeSchema), v.minLength(1), v.maxLength(MAX_SHAPES_PER_CALL)),
    }),
  },
  update_shapes: {
    label: "Editing",
    edits: true,
    description: "Move, resize, recolour or relabel existing shapes. Give only the fields that change.",
    args: v.object({
      updates: v.pipe(v.array(ShapeUpdateSchema), v.minLength(1), v.maxLength(MAX_SHAPES_PER_CALL)),
    }),
  },
  delete_shapes: {
    label: "Erasing",
    edits: true,
    description: "Remove shapes from the page.",
    args: v.object({
      shapeIds: v.pipe(v.array(ShapeIdSchema), v.minLength(1), v.maxLength(MAX_SHAPES_PER_CALL * 2)),
    }),
  },
} as const;

export type CanvasToolName = keyof typeof CANVAS_TOOLS;
export type CanvasToolArgs<T extends CanvasToolName> = v.InferOutput<(typeof CANVAS_TOOLS)[T]["args"]>;

export function isCanvasToolName(value: unknown): value is CanvasToolName {
  return typeof value === "string" && Object.hasOwn(CANVAS_TOOLS, value);
}

/** One call, already validated against its tool's arguments. */
export type CanvasToolCall = {
  [T in CanvasToolName]: { tool: T; args: CanvasToolArgs<T> };
}[CanvasToolName];

export function parseCanvasToolCall(tool: unknown, args: unknown): CanvasToolCall | null {
  if (!isCanvasToolName(tool)) return null;
  const result = v.safeParse(CANVAS_TOOLS[tool].args, args);
  return result.success ? ({ tool, args: result.output } as CanvasToolCall) : null;
}
