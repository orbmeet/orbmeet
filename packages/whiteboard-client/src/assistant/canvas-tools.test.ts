// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  Box,
  Editor,
  createShapeId,
  createTLStore,
  defaultBindingUtils,
  defaultShapeUtils,
  defaultAddFontsFromNode,
  defaultTools,
  tipTapDefaultExtensions,
  type TLArrowBinding,
  type TLGeoShape,
  type TLShapeId,
} from "tldraw";
import { WhiteboardPageShapeUtil } from "../shapes/page/page-shape-util";
import { readPageShapes, resolveAssistantPage } from "./canvas-shapes";
import { capturePageOutline, runCanvasTool } from "./canvas-tools";

const SHAPE_UTILS = [...defaultShapeUtils, WhiteboardPageShapeUtil];
const PAGE_1 = createShapeId("page-1");
const PAGE_2 = createShapeId("page-2");

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** A board with two pages stacked vertically, like the real one. */
function makeBoard(): Editor {
  const container = document.createElement("div");
  document.body.append(container);
  const editor = new Editor({
    store: createTLStore({ shapeUtils: SHAPE_UTILS }),
    shapeUtils: SHAPE_UTILS,
    bindingUtils: defaultBindingUtils,
    tools: defaultTools,
    getContainer: () => container,
    // Labels are rich text; the app gets these from <Tldraw>.
    textOptions: { tipTapConfig: { extensions: tipTapDefaultExtensions }, addFontsFromNode: defaultAddFontsFromNode },
  });
  cleanups.push(() => {
    editor.dispose();
    container.remove();
  });
  editor.updateViewportScreenBounds(new Box(0, 0, 1280, 800));
  editor.createShapes([
    { id: PAGE_1, type: "whiteboard-page", x: 0, y: 0, props: { w: 1600, h: 900 } },
    { id: PAGE_2, type: "whiteboard-page", x: 0, y: 1000, props: { w: 1600, h: 900 } },
  ]);
  return editor;
}

const create = (editor: Editor, pageId: TLShapeId, shapes: unknown[]) =>
  runCanvasTool(editor, pageId, "create_shapes", { shapes });

describe("runCanvasTool", () => {
  it("creates shapes as children of the page, in the page's own coordinates", async () => {
    const editor = makeBoard();
    const outcome = await create(editor, PAGE_2, [
      { _type: "rectangle", shapeId: "start", x: 100, y: 50, w: 200, h: 120, text: "Start", color: "blue", fill: "tint" },
    ]);

    expect(outcome).toEqual({ ok: true, text: "Created: start.", shapes: { created: ["start"] } });
    const shape = editor.getShape<TLGeoShape>(createShapeId("start"))!;
    expect(shape.parentId).toBe(PAGE_2);
    expect(editor.getShapePageBounds(shape)).toMatchObject({ x: 100, y: 1050 });
    expect(shape.props).toMatchObject({ geo: "rectangle", w: 200, color: "blue", fill: "solid" });
  });

  it("binds arrows to shapes created earlier in the same call, even when their ids were taken", async () => {
    const editor = makeBoard();
    await create(editor, PAGE_1, [{ _type: "ellipse", shapeId: "a", x: 0, y: 0, w: 100, h: 100 }]);

    const outcome = await create(editor, PAGE_2, [
      { _type: "rectangle", shapeId: "a", x: 0, y: 0, w: 100, h: 100 },
      { _type: "rectangle", shapeId: "b", x: 400, y: 0, w: 100, h: 100 },
      { _type: "arrow", shapeId: "a-to-b", x1: 100, y1: 50, x2: 400, y2: 50, fromId: "a", toId: "b" },
    ]);

    expect(outcome.text).toBe("Created: a (as a-2, since that id was taken), b, a-to-b.");
    const bindings = editor.getBindingsFromShape<TLArrowBinding>(createShapeId("a-to-b"), "arrow");
    expect(Object.fromEntries(bindings.map((binding) => [binding.props.terminal, binding.toId]))).toEqual({
      start: createShapeId("a-2"),
      end: createShapeId("b"),
    });
  });

  it("reads back what it drew in the same format", async () => {
    const editor = makeBoard();
    await create(editor, PAGE_2, [
      { _type: "diamond", shapeId: "choice", x: 300, y: 200, w: 160, h: 160, text: "Yes?", note: "the decision" },
      { _type: "line", shapeId: "rule", x1: 10, y1: 20, x2: 310, y2: 20, color: "red" },
    ]);

    const shapes = readPageShapes(editor, resolveAssistantPage(editor, PAGE_2)!);
    expect(shapes).toContainEqual({
      _type: "diamond",
      shapeId: "choice",
      x: 300,
      y: 200,
      w: 160,
      h: 160,
      text: "Yes?",
      color: "black",
      fill: "none",
      note: "the decision",
    });
    expect(shapes).toContainEqual({ _type: "line", shapeId: "rule", x1: 10, y1: 20, x2: 310, y2: 20, color: "red", note: undefined });
    expect(readPageShapes(editor, resolveAssistantPage(editor, PAGE_1)!)).toEqual([]);
  });

  it("moves and restyles shapes on the page and leaves other pages alone", async () => {
    const editor = makeBoard();
    await create(editor, PAGE_1, [{ _type: "rectangle", shapeId: "elsewhere", x: 0, y: 0, w: 100, h: 100 }]);
    await create(editor, PAGE_2, [{ _type: "rectangle", shapeId: "here", x: 0, y: 0, w: 100, h: 100 }]);

    const outcome = await runCanvasTool(editor, PAGE_2, "update_shapes", {
      updates: [
        { shapeId: "here", x: 500, y: 300, color: "green", text: "Moved" },
        { shapeId: "elsewhere", x: 500 },
      ],
    });

    expect(outcome).toEqual({ ok: false, text: "Updated: here.\nFailed: elsewhere: elsewhere is not on this page.",
      shapes: { changed: ["here"] },
    });
    const here = editor.getShape<TLGeoShape>(createShapeId("here"))!;
    expect(editor.getShapePageBounds(here)).toMatchObject({ x: 500, y: 1300 });
    expect(here.props.color).toBe("green");
    expect(editor.getShapePageBounds(createShapeId("elsewhere"))).toMatchObject({ x: 0, y: 0 });
  });

  it("deletes only shapes on the page, never the page itself", async () => {
    const editor = makeBoard();
    await create(editor, PAGE_1, [{ _type: "note", shapeId: "keep", x: 0, y: 0, text: "Keep me" }]);
    await create(editor, PAGE_2, [{ _type: "note", shapeId: "drop", x: 0, y: 0, text: "Drop me" }]);

    const outcome = await runCanvasTool(editor, PAGE_2, "delete_shapes", { shapeIds: ["drop", "keep", "page-2"] });

    expect(outcome.ok).toBe(false);
    expect(editor.getShape(createShapeId("drop"))).toBeUndefined();
    expect(editor.getShape(createShapeId("keep"))).toBeDefined();
    expect(editor.getShape(PAGE_2)).toBeDefined();
  });

  it("draws a freehand stroke through the given points", async () => {
    const editor = makeBoard();
    await create(editor, PAGE_2, [
      { _type: "draw", shapeId: "squiggle", points: [{ x: 10, y: 10 }, { x: 110, y: 60 }, { x: 210, y: 10 }], color: "violet" },
    ]);

    const stroke = editor.getShape(createShapeId("squiggle"))!;
    expect(stroke).toMatchObject({ type: "draw", parentId: PAGE_2, props: { color: "violet", isComplete: true } });
    expect(editor.getShapePageBounds(stroke)!.w).toBeGreaterThan(150);
  });

  it("refuses malformed arguments and unknown pages without touching the board", async () => {
    const editor = makeBoard();
    const before = editor.getCurrentPageShapeIds().size;

    expect(await create(editor, PAGE_2, [{ _type: "rectangle", shapeId: "no size", x: 0, y: 0 }])).toMatchObject({ ok: false });
    expect(await create(editor, createShapeId("gone"), [{ _type: "note", shapeId: "n", x: 0, y: 0 }])).toEqual({
      ok: false,
      text: "That page no longer exists.",
    });
    expect(await runCanvasTool(editor, PAGE_2, "erase_everything", {})).toMatchObject({ ok: false });
    expect(editor.getCurrentPageShapeIds().size).toBe(before);
  });
});

describe("capturePageOutline", () => {
  it("describes every page by its words and its ink, in page order", async () => {
    const editor = makeBoard();
    await create(editor, PAGE_2, [
      { _type: "text", shapeId: "eq", x: 40, y: 40, w: 300, h: 60, text: "2x + 5 = 17", fontSize: 24 },
      { _type: "line", shapeId: "numberline", x1: 10, y1: 200, x2: 600, y2: 200 },
    ]);

    expect(capturePageOutline(editor, [PAGE_1, PAGE_2])).toEqual([
      { pageNumber: 1, text: "", drawings: 0, objects: "" },
      { pageNumber: 2, text: "2x + 5 = 17", drawings: 1, objects: "" },
    ]);
  });
});
