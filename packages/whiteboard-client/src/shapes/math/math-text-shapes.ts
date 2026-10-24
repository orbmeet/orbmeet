import { getSchema } from "@tiptap/core";
import { Node as ProseMirrorNode, type Schema } from "@tiptap/pm/model";
import {
  createShapeId,
  defaultHandleExternalTextContent,
  getDisplayValues,
  tipTapDefaultExtensions,
  Vec,
  type Editor,
  type TextShapeUtil,
  type TLRichText,
  type TLShape,
  type TLShapeId,
  type TLShapePartial,
  type TLTextExternalContent,
  type TLTextShape,
} from "tldraw";
import {
  clampMathScale,
  createMathShapeProps,
  DEFAULT_MATH_HEIGHT,
  DEFAULT_MATH_WIDTH,
  MATH_BASE_FONT_SIZE,
  MATH_SHAPE_TYPE,
  MAX_MATH_INPUT_LENGTH,
} from "@orbmeet/whiteboard-core/math-shape-schema";
import { INLINE_MATH_NODE } from "@orbmeet/whiteboard-core/math/constants";
import { resolveMathLatex } from "./math-input";
import { convertDelimitedMath, getLoneEquation, type LoneEquation } from "./math-conversion";
import { measureMathShape } from "./math-shape-util";

/**
 * Math in the canvas' rich text, at the level of shapes.
 *
 * Equations are converted where text enters the board, never by rewriting
 * shapes that are already on it. The text editor converts as the author types
 * or pastes into it; text pasted onto the canvas is converted here, once its
 * shape exists; an agent's diagram labels are converted as they are built
 * (`convertMathInRichText`). Everything else that creates a shape — a
 * duplicate, a paste of copied shapes, an undo or redo — carries rich text
 * that was already through one of those doors, and may hold a `$x$` its
 * author deliberately kept as text.
 */
export function registerMathTextPaste(editor: Editor): () => void {
  editor.registerExternalContentHandler("text", (content) => {
    void pasteTextWithMath(editor, content).catch((error: unknown) => {
      console.error("[whiteboard] Could not paste text:", error);
    });
  });
  return () => {
    editor.registerExternalContentHandler("text", (content) => {
      void defaultHandleExternalTextContent(editor, content);
    });
  };
}

/** tldraw's own text paste, then the equations in the shape it created. */
async function pasteTextWithMath(editor: Editor, content: TLTextExternalContent): Promise<void> {
  const before = new Set(editor.getCurrentPageShapeIds());
  await defaultHandleExternalTextContent(editor, content);
  const updates = [...editor.getCurrentPageShapeIds()]
    .filter((id) => !before.has(id))
    .flatMap((id): TLShapePartial<TLTextShape>[] => {
      // tldraw's text paste creates a text shape and nothing else.
      const shape = editor.getShape(id);
      if (!isTextShape(shape)) return [];
      const converted = convertMathInRichText(editor, shape.props.richText);
      return converted === shape.props.richText
        ? []
        : [{ id, type: "text", props: { richText: converted } }];
    });
  // Same history entry as the paste: one undo takes back both.
  if (updates.length > 0) editor.updateShapes(updates);
}

/** `richText` with its delimited equations converted; the same object when there are none. */
export function convertMathInRichText(editor: Editor, richText: TLRichText): TLRichText {
  const schema = getRichTextSchema(editor);
  return (schema && convertRichText(schema, richText)) ?? richText;
}

/**
 * The equation a text shape holds, when it holds exactly one and nothing else,
 * with LaTeX that is safe to render — what `promoteToMathShape` would place.
 */
export function getPromotableEquation(editor: Editor, shape: TLShape | undefined): LoneEquation | null {
  if (!isTextShape(shape)) return null;
  const schema = getRichTextSchema(editor);
  const doc = schema && readDoc(schema, shape.props.richText);
  const equation = doc && getLoneEquation(doc);
  if (!equation || equation.input.length > MAX_MATH_INPUT_LENGTH) return null;
  const latex = resolveMathLatex(equation.input, equation.latex, equation.displayMode);
  return latex ? { ...equation, latex } : null;
}

/**
 * Replaces a text shape holding one equation with a math shape showing it at
 * the same size, centred where the text was and in its place in the stacking
 * order. Returns the new shape's id, or null when the text is not one equation.
 */
export function promoteToMathShape(editor: Editor, id: TLShapeId): TLShapeId | null {
  const text = editor.getShape(id);
  const equation = getPromotableEquation(editor, text);
  if (!equation || !isTextShape(text)) return null;

  // Match the size the equation rendered at inside the text: the text's font
  // size, times the scale it was created at when zoomed.
  const util = editor.getShapeUtil<TextShapeUtil>("text");
  const fontSize = getDisplayValues(util, text).fontSize * text.props.scale;
  const scale = clampMathScale(fontSize / MATH_BASE_FONT_SIZE);
  const size = measureMathShape(equation.latex, equation.displayMode, scale)
    ?? { w: DEFAULT_MATH_WIDTH, h: DEFAULT_MATH_HEIGHT };

  // `x`/`y` is the shape's origin and rotation turns the shape about it, so the
  // origin that puts the equation's centre on the text's centre is that centre
  // less the half-extent rotated by the same angle.
  const pageCenter = editor.getShapePageBounds(text.id)?.center ?? new Vec(text.x, text.y);
  const center = editor.getPointInParentSpace(text.id, pageCenter);
  const origin = Vec.Sub(center, Vec.Rot(new Vec(size.w / 2, size.h / 2), text.rotation));

  const mathId = createShapeId();
  editor.markHistoryStoppingPoint("math promotion");
  editor.run(() => {
    // Delete first so the equation can take over the text's index.
    editor.deleteShape(text.id);
    editor.createShape({
      id: mathId,
      type: MATH_SHAPE_TYPE,
      parentId: text.parentId,
      index: text.index,
      x: origin.x,
      y: origin.y,
      rotation: text.rotation,
      opacity: text.opacity,
      props: createMathShapeProps({ ...equation, ...size, scale }),
    });
    editor.setSelectedShapes([mathId]);
  });
  return mathId;
}

const schemas = new WeakMap<object, Schema | null>();

/** The schema the board's rich text is written in, when it has inline math. */
function getRichTextSchema(editor: Editor): Schema | null {
  const extensions = editor.getTextOptions().tipTapConfig?.extensions ?? tipTapDefaultExtensions;
  let schema = schemas.get(extensions);
  if (schema === undefined) {
    const candidate = getSchema(extensions);
    schema = candidate.nodes[INLINE_MATH_NODE] ? candidate : null;
    schemas.set(extensions, schema);
  }
  return schema;
}

function isTextShape(shape: TLShape | undefined): shape is TLTextShape {
  return shape?.type === "text";
}

/** The stored JSON as a document, or null when this schema cannot read it — it is peer-written. */
function readDoc(schema: Schema, richText: TLRichText): ProseMirrorNode | null {
  try {
    return ProseMirrorNode.fromJSON(schema, richText);
  } catch {
    return null;
  }
}

/** `richText` with its delimited equations converted, or null when there are none. */
function convertRichText(schema: Schema, richText: TLRichText): TLRichText | null {
  const doc = readDoc(schema, richText);
  if (!doc) return null;
  const content = convertDelimitedMath(doc.content, schema);
  return content === doc.content ? null : doc.copy(content).toJSON() as TLRichText;
}
