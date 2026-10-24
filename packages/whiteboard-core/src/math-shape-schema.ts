import {
  createShapePropsMigrationIds,
  createShapePropsMigrationSequence,
  type TLShape,
} from "@tldraw/tlschema";
import { T } from "@tldraw/validate";
import {
  MAX_MATH_INPUT_LENGTH,
  MAX_MATH_LATEX_LENGTH,
} from "./math/constants.ts";

export { MAX_MATH_INPUT_LENGTH, MAX_MATH_LATEX_LENGTH };

export const MATH_SHAPE_TYPE = "math" as const;
/** Placeholder box for an equation that has not been measured yet. */
export const DEFAULT_MATH_WIDTH = 240;
export const DEFAULT_MATH_HEIGHT = 96;
export const MIN_MATH_WIDTH = 48;
export const MIN_MATH_HEIGHT = 40;
export const MAX_MATH_DIMENSION = 20_000;
export const MATH_PADDING = 20;
export const DEFAULT_MATH_SCALE = 1;
export const MIN_MATH_SCALE = 0.25;
export const MAX_MATH_SCALE = 12;
export const MATH_BASE_FONT_SIZE = 28;

/**
 * `latex` is the canonical field: it is what renders, exports, and gets read
 * by anything downstream. `input` exists only so reopening the editor shows
 * what the author actually typed (`a/b`, not `\frac{a}{b}`); which syntax that
 * is stays derived from the input itself, so the two can never disagree.
 *
 * The transpile happens on write, never on render. That keeps parsing off the
 * render path and — more importantly — means improving the AsciiMath layer can
 * never retroactively change how an existing board renders.
 *
 * `w`/`h` are measured from the rendered equation rather than authored: an
 * equation has a natural size, and a fixed box would either clip it or strand
 * it in whitespace. Resizing changes `scale`, so dragging a corner makes the
 * math bigger instead of the box.
 */
export interface MathShapeProps {
  w: number;
  h: number;
  scale: number;
  input: string;
  latex: string;
  displayMode: boolean;
}

declare module "@tldraw/tlschema" {
  export interface TLGlobalShapePropsMap {
    [MATH_SHAPE_TYPE]: MathShapeProps;
  }
}

export type MathShape = TLShape<typeof MATH_SHAPE_TYPE>;

const boundedDimension = (label: string, minimum: number) =>
  T.number.check(label, (value) => {
    if (!Number.isFinite(value) || value < minimum || value > MAX_MATH_DIMENSION) {
      throw new Error(`Expected ${label} to be in range ${minimum}..${MAX_MATH_DIMENSION}`);
    }
  });

const boundedString = (label: string, maximum: number) =>
  T.string.check(label, (value) => {
    if (value.length > maximum) {
      throw new Error(`Expected ${label} to be at most ${maximum} characters`);
    }
  });

const boundedScale = T.number.check("math scale", (value) => {
  if (!Number.isFinite(value) || value < MIN_MATH_SCALE || value > MAX_MATH_SCALE) {
    throw new Error(`Expected math scale to be in range ${MIN_MATH_SCALE}..${MAX_MATH_SCALE}`);
  }
});

export const MATH_SHAPE_PROPS = {
  w: boundedDimension("math width", MIN_MATH_WIDTH),
  h: boundedDimension("math height", MIN_MATH_HEIGHT),
  scale: boundedScale,
  input: boundedString("math input", MAX_MATH_INPUT_LENGTH),
  latex: boundedString("math latex", MAX_MATH_LATEX_LENGTH),
  displayMode: T.boolean,
};

export function createMathShapeProps(
  overrides: Partial<MathShapeProps> = {},
): MathShapeProps {
  return {
    w: DEFAULT_MATH_WIDTH,
    h: DEFAULT_MATH_HEIGHT,
    scale: DEFAULT_MATH_SCALE,
    input: "",
    latex: "",
    displayMode: true,
    ...overrides,
  };
}

export function clampMathScale(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MATH_SCALE;
  return Math.max(MIN_MATH_SCALE, Math.min(MAX_MATH_SCALE, value));
}

/** Box that fits a measured equation, including padding and the scale floor. */
export function getMathShapeSize(
  contentWidth: number,
  contentHeight: number,
): { w: number; h: number } {
  return {
    w: Math.max(MIN_MATH_WIDTH, Math.min(MAX_MATH_DIMENSION, contentWidth + MATH_PADDING * 2)),
    h: Math.max(MIN_MATH_HEIGHT, Math.min(MAX_MATH_DIMENSION, contentHeight + MATH_PADDING * 2)),
  };
}

const mathShapeVersions = createShapePropsMigrationIds(MATH_SHAPE_TYPE, {
  AsciiMathInput: 1,
});

export const MATH_SHAPE_MIGRATIONS = createShapePropsMigrationSequence({
  sequence: [
    {
      id: mathShapeVersions.AsciiMathInput,
      up(props) {
        // Pre-release dev boards stored a single `source` field in a bespoke
        // syntax. Carry it across as input; rendering derives a bounded local
        // fallback without writing it back. Editing publishes the baked LaTeX.
        const legacySource = typeof props.source === "string" ? props.source : null;
        delete props.source;
        delete props.syntaxVersion;
        // Older records store syntax alongside the input; it is derived from the input.
        delete props.inputMode;

        const input =
          typeof props.input === "string"
            ? props.input
            : (legacySource ?? "");

        props.input = input.slice(0, MAX_MATH_INPUT_LENGTH);
        props.latex =
          typeof props.latex === "string"
            ? props.latex.slice(0, MAX_MATH_LATEX_LENGTH)
            : "";
        props.displayMode =
          typeof props.displayMode === "boolean" ? props.displayMode : true;
        props.scale =
          typeof props.scale === "number"
            ? clampMathScale(props.scale)
            : DEFAULT_MATH_SCALE;
        props.w =
          typeof props.w === "number" && Number.isFinite(props.w)
            ? Math.max(MIN_MATH_WIDTH, Math.min(MAX_MATH_DIMENSION, props.w))
            : DEFAULT_MATH_WIDTH;
        props.h =
          typeof props.h === "number" && Number.isFinite(props.h)
            ? Math.max(MIN_MATH_HEIGHT, Math.min(MAX_MATH_DIMENSION, props.h))
            : DEFAULT_MATH_HEIGHT;
      },
      down(props) {
        props.source = props.input;
        props.syntaxVersion = 1;
        delete props.input;
        delete props.latex;
        delete props.displayMode;
        delete props.scale;
      },
    },
  ],
});
