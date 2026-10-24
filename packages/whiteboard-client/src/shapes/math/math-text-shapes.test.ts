// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createShapeId,
  createTLStore,
  defaultBindingUtils,
  defaultTools,
  Editor,
  toRichText,
  Vec,
  type TLGeoShape,
  type TLRichText,
  type TLShapeId,
  type TLTextShape,
} from "tldraw";
import { whiteboardSyncShapeUtils } from "../../editor/whiteboard-shapes";
import { WHITEBOARD_TLDRAW_OPTIONS } from "../../editor/tldraw-options";
import {
  convertMathInRichText,
  getPromotableEquation,
  promoteToMathShape,
  registerMathTextPaste,
} from "./math-text-shapes";
import {
  MATH_BASE_FONT_SIZE,
  MATH_SHAPE_TYPE,
  MAX_MATH_INPUT_LENGTH,
  MAX_MATH_LATEX_LENGTH,
  type MathShape,
} from "@orbmeet/whiteboard-core/math-shape-schema";
import { INLINE_MATH_NODE } from "@orbmeet/whiteboard-core/math/constants";

// jsdom has no layout, so measuring an equation would always fall back to the
// default box. A measured size unlike the default is what proves placement is
// computed from the box the shape is actually created with.
const MEASURED = { w: 70, h: 75 };
vi.mock("./math-shape-util", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./math-shape-util")>()),
  measureMathShape: () => MEASURED,
}));

/** A tldraw editor owns reactors and timers, so every one opened gets closed. */
const openEditors: Array<{ editor: Editor; dispose: () => void }> = [];

afterEach(() => {
  for (const { editor, dispose } of openEditors.splice(0)) {
    dispose();
    editor.dispose();
  }
});

/** The real editor and store, with the whiteboard's own rich-text options. */
function createEditor() {
  const shapeUtils = whiteboardSyncShapeUtils;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const editor = new Editor({
    store: createTLStore({ shapeUtils }),
    shapeUtils,
    bindingUtils: defaultBindingUtils,
    tools: defaultTools,
    getContainer: () => container,
    options: { text: WHITEBOARD_TLDRAW_OPTIONS.text },
  });
  const dispose = registerMathTextPaste(editor);
  openEditors.push({ editor, dispose });
  return editor;
}

const paragraph = (...content: unknown[]) => ({ type: "paragraph", content });
const doc = (...content: unknown[]) => ({ type: "doc", content }) as TLRichText;
const math = (input: string, latex: string, displayMode = false) => ({
  type: INLINE_MATH_NODE,
  attrs: { input, latex, displayMode },
});

/** A text shape created directly, as a duplicate or a paste of copied shapes creates one. */
function createText(
  editor: Editor,
  richText: TLRichText | string,
  partial: Partial<TLTextShape> = {},
) {
  const id = partial.id ?? createShapeId();
  editor.createShape<TLTextShape>({
    ...partial,
    id,
    type: "text",
    props: {
      ...partial.props,
      richText: typeof richText === "string" ? toRichText(richText) : richText,
    },
  });
  return id;
}

/** A text shape holding what the author typed, its equations converted as the text editor does. */
function typed(editor: Editor, text: string, partial: Partial<TLTextShape> = {}) {
  return createText(editor, convertMathInRichText(editor, toRichText(text)), partial);
}

/** Text pasted onto the canvas from outside the board, through tldraw's paste path. */
async function pasteText(editor: Editor, text: string): Promise<TLShapeId> {
  const before = new Set(editor.getCurrentPageShapeIds());
  await editor.putExternalContent({ type: "text", text, point: { x: 0, y: 0 } });
  // The handler finishes its work after putExternalContent returns.
  await new Promise((resolve) => setTimeout(resolve, 0));
  const [id, ...rest] = [...editor.getCurrentPageShapeIds()].filter((shapeId) => !before.has(shapeId));
  expect(rest).toEqual([]);
  return id;
}

const richTextOf = (editor: Editor, id: TLShapeId) =>
  editor.getShape<TLTextShape>(id)!.props.richText;
const shapes = (editor: Editor) => editor.getCurrentPageShapesSorted();
const onlyMath = (editor: Editor) => {
  const [shape, ...rest] = shapes(editor);
  expect(rest).toEqual([]);
  expect(shape.type).toBe(MATH_SHAPE_TYPE);
  return shape as MathShape;
};

/** The centre of a shape's box, from its origin, size and rotation. */
const centreOf = (shape: MathShape) =>
  Vec.Add(new Vec(shape.x, shape.y), Vec.Rot(new Vec(shape.props.w / 2, shape.props.h / 2), shape.rotation));

describe("rich text arriving on the board", () => {
  it("converts equations in text pasted onto the canvas, keeping the text around them", async () => {
    const editor = createEditor();
    const id = await pasteText(editor, "the area is $pi r^2$ exactly");

    expect(richTextOf(editor, id)).toMatchObject(
      doc(paragraph(
        { type: "text", text: "the area is " },
        math("pi r^2", "\\pi r^{2}"),
        { type: "text", text: " exactly" },
      )),
    );
  });

  it("makes conversion part of the paste, so one undo removes both", async () => {
    const editor = createEditor();
    editor.markHistoryStoppingPoint("paste");
    await pasteText(editor, "so $x$ ok");
    editor.undo();

    expect(shapes(editor)).toEqual([]);
  });

  it("keeps a lone pasted equation as text until asked to promote it", async () => {
    const editor = createEditor();
    const id = await pasteText(editor, "$x^2$");

    expect(shapes(editor).map((shape) => shape.type)).toEqual(["text"]);
    expect(richTextOf(editor, id)).toMatchObject(doc(paragraph(math("x^2", "x^{2}"))));
  });

  it("pastes plain text once disposed", async () => {
    const editor = createEditor();
    openEditors.at(-1)!.dispose();
    const id = await pasteText(editor, "so $x^2$");

    expect(richTextOf(editor, id)).toEqual(toRichText("so $x^2$"));
  });
});

describe("rich text already on the board", () => {
  // `$x$` typed and then taken back with Backspace: the author chose text.
  const literal = "costs $x$ today";

  it("is not rewritten when a shape is created from it, as a paste of copied shapes does", () => {
    const editor = createEditor();
    const id = createText(editor, literal);

    expect(richTextOf(editor, id)).toEqual(toRichText(literal));
  });

  it("is not rewritten by a duplicate", () => {
    const editor = createEditor();
    const id = createText(editor, literal);
    editor.duplicateShapes([id]);

    for (const shape of shapes(editor)) {
      expect((shape as TLTextShape).props.richText).toEqual(toRichText(literal));
    }
    expect(shapes(editor)).toHaveLength(2);
  });

  it("is not rewritten when undo brings a deleted shape back", () => {
    const editor = createEditor();
    const id = createText(editor, literal);
    editor.markHistoryStoppingPoint("delete");
    editor.deleteShapes([id]);
    editor.undo();

    expect(richTextOf(editor, id)).toEqual(toRichText(literal));
  });
});

describe("converting rich text", () => {
  const convert = (richText: TLRichText | string) =>
    convertMathInRichText(createEditor(), typeof richText === "string" ? toRichText(richText) : richText);

  it("converts every delimited equation in a document", () => {
    expect(convert("area $pi r^2$")).toMatchObject(
      doc(paragraph({ type: "text", text: "area " }, math("pi r^2", "\\pi r^{2}"))),
    );
  });

  it("converts delimited text beside an existing equation", () => {
    expect(convert(doc(paragraph(math("x^2", "x^{2}"), { type: "text", text: "$y^2$" })))).toMatchObject(
      doc(paragraph(math("x^2", "x^{2}"), math("y^2", "y^{2}"))),
    );
  });

  it("returns unreadable rich text as it is", () => {
    const broken = { type: "doc", content: [{ type: "no-such-node", text: "$x$" }] } as TLRichText;
    expect(convert(broken)).toBe(broken);
  });

  it.each([
    ["prices", "It cost $5 and $10"],
    ["a price range", "$5-$10"],
    ["undelimited maths", "x^2 + 1"],
    ["math that will not render", "$\\frac$"],
    ["display-only LaTeX between inline delimiters", String.raw`$\begin{align}x&=1\end{align}$`],
    ["input that transpiles but cannot render", `$$${"or".repeat(MAX_MATH_INPUT_LENGTH / 2)}$$`],
    ["LaTeX too long to store", `$$\\quad ${"x".repeat(MAX_MATH_INPUT_LENGTH - 6)}+y$$`],
  ])("leaves %s alone", (_label, text) => {
    const richText = toRichText(text);
    expect(convertMathInRichText(createEditor(), richText)).toBe(richText);
  });
});

describe("promotion to a math shape", () => {
  it("offers only a text shape that is one equation", () => {
    const editor = createEditor();
    const lone = typed(editor, "$x^2$");
    const sentence = typed(editor, "so $x^2$");
    const two = typed(editor, "$x$ $y$");
    const geo = createShapeId();
    editor.createShape<TLGeoShape>({ id: geo, type: "geo", props: { richText: toRichText("$x$") } });

    expect(getPromotableEquation(editor, editor.getShape(lone))).toMatchObject({ input: "x^2", latex: "x^{2}" });
    for (const id of [sentence, two, geo]) {
      expect(getPromotableEquation(editor, editor.getShape(id))).toBeNull();
    }
    expect(promoteToMathShape(editor, sentence)).toBeNull();
    expect(editor.getShape(sentence)?.type).toBe("text");
  });

  it("replaces the text with a math shape and selects it", () => {
    const editor = createEditor();
    const id = typed(editor, "$$ (a+10)/(b-10) $$");
    const mathId = promoteToMathShape(editor, id);

    expect(onlyMath(editor)).toMatchObject({
      id: mathId,
      props: { input: "(a+10)/(b-10)", latex: "\\frac{a + 10}{b - 10}", displayMode: true },
    });
    expect(editor.getSelectedShapeIds()).toEqual([mathId]);
  });

  it("keeps the baked output of a lone equation among blank paragraphs", () => {
    const editor = createEditor();
    const id = createText(editor, doc({ type: "paragraph" }, paragraph(math("x", "y")), { type: "paragraph" }));
    promoteToMathShape(editor, id);

    expect(onlyMath(editor).props).toMatchObject({ input: "x", latex: "y", displayMode: false });
  });

  it("rebuilds peer-written LaTeX that will not render from its source", () => {
    const editor = createEditor();
    const id = createText(editor, doc(paragraph(math("x^2", "\\badcmd"))));
    promoteToMathShape(editor, id);

    expect(onlyMath(editor).props).toMatchObject({ input: "x^2", latex: "x^{2}" });
  });

  it("undoes back to the text it replaced in one step", () => {
    const editor = createEditor();
    const id = typed(editor, "$x^2$");
    promoteToMathShape(editor, id);
    editor.undo();

    expect(shapes(editor).map((shape) => shape.id)).toEqual([id]);
  });

  it("sizes the equation like the text it replaces", () => {
    const editor = createEditor();
    const id = typed(editor, "$x^2$", { props: { size: "xl", scale: 2 } as TLTextShape["props"] });
    promoteToMathShape(editor, id);

    const fontSize = editor.getCurrentTheme().fontSize * 2.75 * 2;
    expect(onlyMath(editor).props.scale).toBeCloseTo(fontSize / MATH_BASE_FONT_SIZE);
  });

  it("centres the equation on the text it replaces, even when rotated", () => {
    const editor = createEditor();
    const id = typed(editor, "$x^2$", { x: 40, y: 60, rotation: Math.PI / 2 });
    const textCentre = editor.getShapePageBounds(id)!.center;
    promoteToMathShape(editor, id);

    const shape = onlyMath(editor);
    expect(shape.rotation).toBe(Math.PI / 2);
    expect(shape.props).toMatchObject(MEASURED);
    expect(centreOf(shape).x).toBeCloseTo(textCentre.x);
    expect(centreOf(shape).y).toBeCloseTo(textCentre.y);
  });

  it("keeps the equation in its frame, in the text's place in the stack", () => {
    const editor = createEditor();
    const frame = createShapeId();
    editor.createShape({ id: frame, type: "frame", x: 300, y: 200, props: { w: 800, h: 600 } });
    const below = createShapeId();
    editor.createShape({ id: below, type: "geo", parentId: frame, x: 0, y: 0 });
    const text = typed(editor, "$x^2$", { parentId: frame, x: 40, y: 60, opacity: 0.5 });
    const above = createShapeId();
    editor.createShape({ id: above, type: "geo", parentId: frame, x: 0, y: 0 });
    const textCentre = editor.getShapePageBounds(text)!.center;
    promoteToMathShape(editor, text);

    const children = editor.getSortedChildIdsForParent(frame).map((id) => editor.getShape(id)!);
    expect(children.map((shape) => shape.type)).toEqual(["geo", MATH_SHAPE_TYPE, "geo"]);
    const shape = children[1] as MathShape;
    expect(shape.opacity).toBe(0.5);
    const pageCentre = editor.getShapePageTransform(shape.id).applyToPoint(
      new Vec(shape.props.w / 2, shape.props.h / 2),
    );
    expect(pageCentre.x).toBeCloseTo(textCentre.x);
    expect(pageCentre.y).toBeCloseTo(textCentre.y);
  });

  it("bakes long LaTeX the shape's own validator accepts", () => {
    const editor = createEditor();
    const id = typed(editor, `$$${"a + ".repeat(200)}a$$`);
    promoteToMathShape(editor, id);

    expect(onlyMath(editor).props.latex.length).toBeLessThanOrEqual(MAX_MATH_LATEX_LENGTH);
  });
});
