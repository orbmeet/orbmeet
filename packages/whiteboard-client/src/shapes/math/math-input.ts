import { asciiMathToLatex } from "./asciimath";
import { readAsciiMathText } from "./asciimath-text";
import {
  MAX_MATH_INPUT_LENGTH,
  MAX_MATH_LATEX_LENGTH,
} from "@orbmeet/whiteboard-core/math/constants";
import { getKatexError } from "./katex-renderer";

export { MAX_MATH_INPUT_LENGTH, MAX_MATH_LATEX_LENGTH } from "@orbmeet/whiteboard-core/math/constants";

export type MathInputMode = "asciimath" | "latex";

/**
 * The parser is synchronous and its grammar backtracks. Storage remains roomy
 * for direct LaTeX, but AsciiMath is refused before parsing once its source or
 * ambiguity budget becomes expensive enough to block a canvas frame.
 */
export const MAX_ASCIIMATH_INPUT_LENGTH = 1_000;

/**
 * The AsciiMath transpiler is a backtracking recursive-descent parser with no
 * memoisation, so a bracketed level re-parses its contents through several
 * productions and nesting makes that cost compound: parse time grows roughly
 * 2.5x per bracket level — still sub-frame at ten, seconds by twenty, an
 * unbounded hang beyond. It runs synchronously on every keystroke, and the
 * length cap is no defence because a couple of dozen brackets is already
 * enough. The scan rejects known expensive shapes before parsing; the parser
 * also enforces a work budget in case its grammar and this scan disagree.
 */
const MAX_MATH_NESTING_DEPTH = 12;
const MAX_ASCIIMATH_COMPLEXITY = 8_192;
const MAX_AMBIGUOUS_BARS = 12;

function getAsciiMathComplexity(input: string): {
  deepest: number;
  bars: number;
} {
  let depth = 0;
  let deepest = 0;
  let bars = 0;
  for (let index = 0; index < input.length; index++) {
    // Consume text forms before looking for quotes inside them. For example,
    // text(") ends at the parenthesis; its quote cannot hide later brackets.
    const text = readAsciiMathText(input, index);
    if (text) {
      index = text.end - 1;
      continue;
    }
    const char = input[index];
    if (char === "(" || char === "[" || char === "{") {
      depth += 1;
      if (depth > deepest) deepest = depth;
    } else if (char === ")" || char === "]" || char === "}") {
      if (depth > 0) depth -= 1;
    } else if (char === "|") {
      bars += 1;
    }
  }
  return { deepest, bars };
}

function getAsciiMathComplexityError(input: string): string | null {
  if (input.length > MAX_ASCIIMATH_INPUT_LENGTH) {
    return "That AsciiMath expression is too long to parse safely.";
  }

  const { deepest, bars } = getAsciiMathComplexity(input);
  if (
    deepest > MAX_MATH_NESTING_DEPTH ||
    input.length * 2 ** deepest > MAX_ASCIIMATH_COMPLEXITY
  ) {
    return "That expression is nested too deeply to render.";
  }
  if (bars > MAX_AMBIGUOUS_BARS) {
    return "That expression has too many ambiguous | delimiters to render safely.";
  }
  return null;
}

/**
 * A leading backslash is the escape hatch for the minority who write LaTeX
 * directly; everything else is AsciiMath, where `a/b`, `A vv B` and
 * `[[a,b],[c,d]]` mean what they look like.
 */
export function detectMathInputMode(input: string): MathInputMode {
  return input.trimStart().startsWith("\\") ? "latex" : "asciimath";
}

export interface CompiledMathInput {
  /** Baked LaTeX, or null when there is nothing publishable yet. */
  latex: string | null;
  /** Set when the input cannot be transpiled, is too long, or will not render. */
  error: string | null;
  /**
   * Advice for input that compiles but almost certainly does not mean what the
   * author intended. AsciiMath never fails, so these are the only signal for a
   * whole class of mistakes.
   */
  hint: string | null;
}

const EMPTY: CompiledMathInput = {
  latex: null,
  error: null,
  hint: null,
};

/**
 * LaTeX and Typst habits that AsciiMath silently accepts as something else.
 * `frac(a,b)` becomes `\frac{a , b}{}` — a visibly empty denominator with no
 * error anywhere.
 */
const INPUT_HINTS: ReadonlyArray<{ pattern: RegExp; hint: string }> = [
  {
    pattern: /\bfrac\s*\(/,
    hint: "AsciiMath writes fractions with a slash — try (a)/(b) instead of frac(a,b).",
  },
  {
    pattern: /\b(union|intersect)\b/,
    hint: "Use the short operators — uu for ∪ and nn for ∩.",
  },
];

function getInputHint(input: string): string | null {
  for (const { pattern, hint } of INPUT_HINTS) {
    if (pattern.test(input)) return hint;
  }
  return null;
}

/**
 * Compiles authoring input down to the LaTeX that gets stored on the shape.
 * This runs on edit, never on render — see `math-shape-schema` for why the
 * LaTeX is baked rather than re-derived.
 *
 * `latex` is only non-null when the result is safe to publish to the room: it
 * transpiled, it fits the field, and KaTeX will render it. Callers keep the
 * previously baked LaTeX otherwise, so nobody watches an error flash across the
 * canvas while the author is still typing.
 */
export function compileMathInput(
  input: string,
  mode: MathInputMode = detectMathInputMode(input),
  displayMode = true,
): CompiledMathInput {
  const trimmed = input.trim();
  if (!trimmed) return EMPTY;

  const hint = mode === "asciimath" ? getInputHint(trimmed) : null;
  let latex: string;

  if (mode === "latex") {
    latex = trimmed;
  } else {
    // Guard the transpiler before it runs, not after: pathological inputs can
    // keep its synchronous backtracking grammar busy for many seconds.
    const complexityError = getAsciiMathComplexityError(trimmed);
    if (complexityError) {
      return {
        latex: null,
        error: complexityError,
        hint: null,
      };
    }
    try {
      latex = asciiMathToLatex(trimmed);
    } catch (error) {
      return {
        latex: null,
        error:
          error instanceof Error ? error.message : "Could not read that expression",
        hint: null,
      };
    }
  }

  if (latex.length > MAX_MATH_LATEX_LENGTH) {
    // Truncating would not give a smaller equation, just a broken one — a
    // LaTeX string cut mid-command renders as an error.
    return {
      latex: null,
      error: "That expression is too long to render.",
      hint: null,
    };
  }

  const renderError = getKatexError(latex, displayMode);
  if (renderError) {
    return { latex: null, error: renderError, hint: null };
  }

  return { latex, error: null, hint };
}

/**
 * Resolve peer-writable baked output without trusting it blindly. Valid baked
 * LaTeX wins; malformed legacy records may derive a bounded local fallback from
 * their source, but that fallback is never written back merely to render it.
 */
export function resolveMathLatex(input: string, bakedLatex: string, displayMode = true): string | null {
  if (
    bakedLatex.length <= MAX_MATH_LATEX_LENGTH &&
    bakedLatex &&
    getKatexError(bakedLatex, displayMode) === null
  ) {
    return bakedLatex;
  }
  if (input.length > MAX_MATH_INPUT_LENGTH) return null;
  return compileMathInput(input, undefined, displayMode).latex;
}

export interface BakedMath {
  input: string;
  latex: string;
  displayMode: boolean;
}

/**
 * Turns delimited source into the attributes an equation is stored with, or
 * null when it should stay text: too long to store, or a genuine compile error
 * — an undefined command, an unbalanced brace — that will never render and is
 * better left editable than locked into an atom showing its own source.
 */
export function bakeMath(input: string, displayMode: boolean): BakedMath | null {
  if (input.length > MAX_MATH_INPUT_LENGTH) return null;
  const { latex } = compileMathInput(input, undefined, displayMode);
  return latex ? { input, latex, displayMode } : null;
}
