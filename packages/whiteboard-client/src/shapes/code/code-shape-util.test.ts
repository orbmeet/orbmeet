import { renderToStaticMarkup } from "react-dom/server";
import * as stylex from "@stylexjs/stylex";
import { Box, Vec, type Editor } from "tldraw";
import { describe, expect, it } from "vitest";
import { CodeShapeUtil, renderCodeSvg } from "./code-shape-util";
import {
  CODE_SHAPE_TYPE,
  createCodeShapeProps,
  DEFAULT_CODE_HEIGHT,
  DEFAULT_CODE_WIDTH,
  MAX_CODE_HEIGHT,
  MAX_CODE_WIDTH,
  MIN_CODE_HEIGHT,
  MIN_CODE_WIDTH,
  type CodeShape,
} from "@orbmeet/whiteboard-core/code-shape-schema";

function createCodeShape(props: Partial<CodeShape["props"]> = {}): CodeShape {
  return {
    id: "shape:code-test",
    typeName: "shape",
    type: CODE_SHAPE_TYPE,
    x: 50,
    y: 100,
    rotation: 0,
    index: "a1",
    parentId: "page:page",
    isLocked: false,
    opacity: 1,
    meta: {},
    props: { ...createCodeShapeProps(), ...props },
  } as CodeShape;
}

const util = () => new CodeShapeUtil({} as Editor);

/**
 * Enough editor for the shape's own component: it reads four signals and marks
 * pointer events as handled, nothing more.
 */
const stubEditor = {
  getIsReadonly: () => false,
  user: { getIsDarkMode: () => false },
  getSelectedShapeIds: () => [],
  getEditingShapeId: () => null,
  markEventAsHandled: () => {},
} as unknown as Editor;

/**
 * StyleX compiles a declaration to one atomic class per property/value pair, so
 * an identical declaration here compiles to the identical class. That makes
 * "this element resolves `display: flex`" an assertion about the built output
 * rather than about the source text.
 */
const layout = stylex.create({
  columnFlex: { display: "flex", flexDirection: "column" },
  preservesNewlines: { whiteSpace: "pre" },
});

const classesOf = (style: stylex.StyleXStyles) =>
  (stylex.props(style).className ?? "").split(" ").filter(Boolean);

describe("CodeShapeUtil", () => {
  it("describes itself for assistive technology", () => {
    expect(util().getAriaDescriptor(createCodeShape())).toBe("JavaScript code block");
    expect(util().getAriaDescriptor(createCodeShape({ language: "cpp" }))).toBe(
      "C++ code block",
    );
  });

  it("clamps a resize to the bounds the schema will accept", () => {
    const shape = createCodeShape();
    const resizeBy = (scale: number) =>
      util().onResize(shape, {
        newPoint: new Vec(50, 100),
        handle: "bottom_right",
        mode: "resize_bounds",
        scaleX: scale,
        scaleY: scale,
        initialBounds: new Box(50, 100, DEFAULT_CODE_WIDTH, DEFAULT_CODE_HEIGHT),
        initialShape: shape,
      });

    expect(resizeBy(0.05).props).toMatchObject({ w: MIN_CODE_WIDTH, h: MIN_CODE_HEIGHT });
    expect(resizeBy(1_000).props).toMatchObject({ w: MAX_CODE_WIDTH, h: MAX_CODE_HEIGHT });
  });

  it("lays the editor out as a column so the textarea can fill the cell", () => {
    // The header and the output tray size to their content; the editor takes
    // what is left, via `flexGrow` on the wrapper and `height: 100%` on the
    // textarea. Both are inert unless this container is a column flex box, and
    // the textarea then collapses to its intrinsic two rows inside a shape
    // whose height the user chose.
    const markup = renderToStaticMarkup(
      new CodeShapeUtil(stubEditor).component(createCodeShape()),
    );
    const containerClasses =
      markup.match(/<div id="shape:code-test"[^>]*class="([^"]*)"/)?.[1]?.split(" ") ?? [];

    expect(containerClasses).toEqual(expect.arrayContaining(classesOf(layout.columnFlex)));
  });

  it("keeps the line numbers on their own lines without inheriting `pre`", () => {
    // The gutter renders one newline-joined text node. It used to rely on
    // `white-space: pre` inherited from the container, which coupled it to the
    // container's layout: restoring the column flex box above would otherwise
    // have collapsed "1\n2\n3" into "1 2 3" in an anonymous flex item.
    const markup = renderToStaticMarkup(
      new CodeShapeUtil(stubEditor).component(createCodeShape({ code: "one\ntwo\nthree" })),
    );
    const gutterClasses =
      markup.match(/<div class="([^"]*)" aria-hidden="true">1\n2\n3<\/div>/)?.[1]?.split(" ");

    expect(gutterClasses).toBeDefined();
    expect(gutterClasses).toEqual(
      expect.arrayContaining(classesOf(layout.preservesNewlines)),
    );
  });
});

describe("renderCodeSvg", () => {
  it("exports the source under a language header", () => {
    const markup = renderToStaticMarkup(
      renderCodeSvg(createCodeShape({ code: "const total = 1 + 2;" }), false),
    );

    expect(markup).toContain("JAVASCRIPT");
    expect(markup).toContain("const total = 1 + 2;");
  });

  it("exports the output alongside the source", () => {
    // A code cell without its result is half the record of what happened in the
    // meeting, and an export is exactly where that record is read later.
    const markup = renderToStaticMarkup(
      renderCodeSvg(
        createCodeShape({ code: "console.log(6 * 7)", output: "42", status: "success" }),
        false,
      ),
    );

    expect(markup).toContain("42");
  });

  it("colours a failed run's output as an error", () => {
    const markup = renderToStaticMarkup(
      renderCodeSvg(
        createCodeShape({ output: "ReferenceError: nope", status: "error" }),
        false,
      ),
    );

    expect(markup).toContain("#b91c1c");
  });

  it("follows the export context's colour mode", () => {
    const shape = createCodeShape();
    expect(renderToStaticMarkup(renderCodeSvg(shape, true))).toContain("#0f172a");
    expect(renderToStaticMarkup(renderCodeSvg(shape, false))).toContain("#f1f5f9");
  });

  it("clips long lines rather than overflowing the box", () => {
    const markup = renderToStaticMarkup(
      renderCodeSvg(createCodeShape({ code: "z".repeat(400) }), false),
    );

    expect(markup).toContain("…");
    expect(markup).not.toContain("z".repeat(200));
  });

  it("keeps a short cell's source visible when there is no output", () => {
    const shape = createCodeShape({ h: MIN_CODE_HEIGHT, code: "one\ntwo", output: "" });
    expect(renderToStaticMarkup(renderCodeSvg(shape, false))).toContain("one");
  });
});
