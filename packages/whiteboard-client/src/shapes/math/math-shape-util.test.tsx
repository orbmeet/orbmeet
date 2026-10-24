import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Editor, TLResizeInfo } from "tldraw";
import {
  compileMathInput,
  MAX_ASCIIMATH_INPUT_LENGTH,
} from "./math-input";
import {
  clampMathScale,
  createMathShapeProps,
  getMathShapeSize,
  MATH_PADDING,
  MATH_SHAPE_MIGRATIONS,
  MATH_SHAPE_PROPS,
  MAX_MATH_LATEX_LENGTH,
  MAX_MATH_SCALE,
  MIN_MATH_HEIGHT,
  MIN_MATH_SCALE,
  MIN_MATH_WIDTH,
  type MathShape,
} from "@orbmeet/whiteboard-core/math-shape-schema";
import { MathShapeUtil, renderMathSvg } from "./math-shape-util";

function createMathShape(props: Partial<MathShape["props"]> = {}): MathShape {
  return {
    id: "shape:math-test",
    typeName: "shape",
    type: "math",
    x: 10,
    y: 20,
    rotation: 0,
    index: "a1",
    parentId: "page:page",
    isLocked: false,
    opacity: 1,
    meta: {},
    props: createMathShapeProps({
      input: "(a+10)/(b-10)",
      latex: "\\frac{a + 10}{b - 10}",
      ...props,
    }),
  } as unknown as MathShape;
}

const migrateUp = (props: Record<string, unknown>) => {
  const migration = MATH_SHAPE_MIGRATIONS.sequence[0];
  if (!("up" in migration)) throw new Error("expected an up migration");
  migration.up(props);
  return props;
};

describe("math shape props", () => {
  it("validates the props a shape is created with", () => {
    const props = createMathShape().props as unknown as Record<string, unknown>;
    for (const [key, validator] of Object.entries(MATH_SHAPE_PROPS)) {
      expect(validator.isValid(props[key])).toBe(true);
    }
  });

  it("rejects dimensions below the resize floor", () => {
    // The validator floor and the onResize floor used to disagree, so a peer
    // could persist a 1x1 shape that the resize path would never produce.
    expect(MATH_SHAPE_PROPS.w.isValid(MIN_MATH_WIDTH - 1)).toBe(false);
    expect(MATH_SHAPE_PROPS.h.isValid(MIN_MATH_HEIGHT - 1)).toBe(false);
    expect(MATH_SHAPE_PROPS.w.isValid(MIN_MATH_WIDTH)).toBe(true);
  });

  it("bounds the baked LaTeX, which any peer can write", () => {
    expect(MATH_SHAPE_PROPS.latex.isValid("x".repeat(MAX_MATH_LATEX_LENGTH))).toBe(true);
    expect(MATH_SHAPE_PROPS.latex.isValid("x".repeat(MAX_MATH_LATEX_LENGTH + 1))).toBe(false);
  });

  it("gives the baked LaTeX room for the worst AsciiMath expansion", () => {
    // `or` -> `\quad\text{or}\quad` is the biggest blow-up in the symbol table
    // at 10x. Anything short enough to type has to fit, or the delimiter path
    // would hand createShape a value its own validator rejects.
    const compiled = compileMathInput("or".repeat(MAX_ASCIIMATH_INPUT_LENGTH / 2));

    expect(compiled.latex).not.toBeNull();
    expect(MATH_SHAPE_PROPS.latex.isValid(compiled.latex)).toBe(true);
  });
});

describe("math shape migration", () => {
  it("carries a legacy source field across as authoring input", () => {
    const migrated = migrateUp({ w: 360, h: 160, source: "x^2", syntaxVersion: 1 });

    expect(migrated).toMatchObject({
      input: "x^2",
      latex: "",
      displayMode: true,
    });
    expect(migrated.source).toBeUndefined();
    expect(migrated.syntaxVersion).toBeUndefined();
  });

  it("drops the stored syntax, which is derived from the input now", () => {
    const migrated = migrateUp({ source: "\\frac{1}{2}", inputMode: "asciimath" });

    // A stored mode could disagree with the input it describes; nothing reads
    // it any more, so it must not survive the migration either.
    expect(migrated.inputMode).toBeUndefined();
  });

  it("clamps dimensions to the supported range", () => {
    expect(migrateUp({ w: 1, h: 1, source: "" })).toMatchObject({
      w: MIN_MATH_WIDTH,
      h: MIN_MATH_HEIGHT,
    });
  });
});

describe("math sizing", () => {
  it("wraps the measured equation in padding", () => {
    expect(getMathShapeSize(200, 60)).toEqual({
      w: 200 + MATH_PADDING * 2,
      h: 60 + MATH_PADDING * 2,
    });
  });

  it("never sizes below the minimum box", () => {
    // An empty equation still gets a grabbable box.
    expect(getMathShapeSize(0, 0)).toEqual({
      w: MIN_MATH_WIDTH,
      h: MIN_MATH_HEIGHT,
    });
    // Padding alone already clears the height floor, so any content grows it.
    expect(getMathShapeSize(1, 1).h).toBe(1 + MATH_PADDING * 2);
  });

  it("clamps scale to the supported range", () => {
    expect(clampMathScale(0)).toBe(MIN_MATH_SCALE);
    expect(clampMathScale(999)).toBe(MAX_MATH_SCALE);
    expect(clampMathScale(Number.NaN)).toBe(1);
    expect(clampMathScale(2)).toBe(2);
  });

  it("resizes the equation rather than the box", () => {
    const util = new MathShapeUtil({} as Editor);
    const shape = createMathShape();
    const result = util.onResize?.(shape, {
      initialShape: shape,
      scaleX: 2,
      scaleY: 2,
    } as TLResizeInfo<MathShape>);

    // Only the scale moves — w/h are remeasured from the rendered output.
    expect(result?.props?.scale).toBe(2);
    expect(result?.props).not.toHaveProperty("w");
    expect(result?.props).not.toHaveProperty("h");
  });

  it("keeps scale within range when dragged far", () => {
    const util = new MathShapeUtil({} as Editor);
    const shape = createMathShape();
    const result = util.onResize?.(shape, {
      initialShape: shape,
      scaleX: 500,
      scaleY: 500,
    } as TLResizeInfo<MathShape>);

    expect(result?.props?.scale).toBe(MAX_MATH_SCALE);
  });
});

describe("renderMathSvg", () => {
  it("exports baked LaTeX through KaTeX", () => {
    const markup = renderToStaticMarkup(renderMathSvg(createMathShape(), false));

    expect(markup).toContain("foreignObject");
    expect(markup).toContain("tl-export-embed-styles");
    expect(markup).toContain('class="katex');
    expect(markup).toContain("mfrac");
  });

  it("uses a light foreground on dark exports", () => {
    const light = renderToStaticMarkup(renderMathSvg(createMathShape(), false));
    const dark = renderToStaticMarkup(renderMathSvg(createMathShape(), true));

    expect(light).toContain("#18181b");
    expect(dark).toContain("#f4f4f5");
  });

  it("derives a bounded local fallback when nothing has been baked", () => {
    const markup = renderToStaticMarkup(
      renderMathSvg(createMathShape({ input: "a/b", latex: "" }), false),
    );

    expect(markup).toContain("katex");
    expect(markup).toContain("mfrac");
  });

  it("derives the same fallback when legacy baked output is malformed", () => {
    const markup = renderToStaticMarkup(
      renderMathSvg(
        createMathShape({ input: "a/b", latex: "\\badcmd" }),
        false,
      ),
    );

    expect(markup).toContain("katex");
    expect(markup).toContain("mfrac");
  });
});
