import { describe, expect, it } from "vitest";
import AsciiMathParser from "asciimath2tex";
import { asciiMathToLatex } from "./asciimath";
import {
  compileMathInput,
  detectMathInputMode,
  MAX_ASCIIMATH_INPUT_LENGTH,
  MAX_MATH_LATEX_LENGTH,
} from "./math-input";

const latexOf = (input: string) => compileMathInput(input).latex;

describe("detectMathInputMode", () => {
  it("treats a leading backslash as the LaTeX escape hatch", () => {
    expect(detectMathInputMode("\\int_0^1 x^2 dx")).toBe("latex");
    expect(detectMathInputMode("  \\frac{1}{2}")).toBe("latex");
    expect(detectMathInputMode("a/b")).toBe("asciimath");
    expect(detectMathInputMode("x^2")).toBe("asciimath");
  });
});

describe("compileMathInput conversions", () => {
  it("is deterministic without an asynchronous loader race", () => {
    const result = compileMathInput("a/b");
    expect(result).toMatchObject({ latex: "\\frac{a}{b}" });
  });
});

describe("compileMathInput", () => {
  it("writes fractions with a slash instead of \\frac", () => {
    expect(latexOf("a/b")).toBe("\\frac{a}{b}");
    expect(latexOf("(a+10)/(b-10)")).toBe("\\frac{a + 10}{b - 10}");
    expect(latexOf("(x^2+1)/(2x)")).toBe("\\frac{x^{2} + 1}{2 x}");
  });

  it("supports short-form logic and set operators", () => {
    expect(latexOf("A vv B")).toBe("A \\vee B");
    expect(latexOf("A ^^ B")).toBe("A \\wedge B");
    expect(latexOf("A uu B")).toBe("A \\cup B");
    expect(latexOf("A nn B")).toBe("A \\cap B");
    expect(latexOf("not A")).toBe("\\neg A");
    expect(latexOf("AA x in RR")).toBe("\\forall x \\in \\mathbb{R}");
    expect(latexOf("EE y")).toBe("\\exists y");
  });

  it("supports matrices and vectors", () => {
    expect(latexOf("[[a,b],[c,d]]")).toContain("\\begin{matrix} a & b \\\\ c & d \\end{matrix}");
    expect(latexOf("((a),(b),(c))")).toContain("\\begin{matrix} a \\\\ b \\\\ c \\end{matrix}");
    expect(latexOf("vec(x)")).toBe("\\vec{x}");
  });

  it("handles implicit multiplication, which the previous parser rejected", () => {
    expect(latexOf("2x")).toBe("2 x");
    expect(latexOf("2 pi r")).toBe("2 \\pi r");
    expect(latexOf("(a+b)(c-d)")).toBe("\\left ( a + b \\right ) \\left ( c - d \\right )");
  });

  it("preserves identifier case", () => {
    // The previous parser lowercased, turning P(A) into \operatorname{p}.
    expect(latexOf("P(A)")).toBe("P \\left ( A \\right )");
    expect(latexOf("Delta x")).toBe("\\Delta x");
  });

  it("passes LaTeX through untouched", () => {
    expect(compileMathInput("\\int_0^1 x^2 \\, dx")).toEqual({
      latex: "\\int_0^1 x^2 \\, dx",
      error: null,
      hint: null,
    });
  });

  it("returns nothing to render for empty input", () => {
    expect(compileMathInput("   ")).toEqual({
      latex: null,
      error: null,
      hint: null,
    });
  });

  it("hints on habits AsciiMath silently accepts as something else", () => {
    // `frac(a,b)` compiles to \frac{a , b}{} — an empty denominator, no error.
    const frac = compileMathInput("frac(a,b)");
    expect(frac.latex).toBe("\\frac{a , b}{}");
    expect(frac.hint).toMatch(/slash/);

    expect(compileMathInput("sqrt{x}").hint).toBeNull();
    expect(compileMathInput("A union B").hint).toMatch(/uu/);
    expect(compileMathInput("(a+b)/c").hint).toBeNull();
  });

  it("refuses pathologically nested input instead of hanging the parser", () => {
    // asciimath2tex backtracks exponentially on bracket depth, so a few dozen
    // levels would otherwise take seconds-to-forever on the keystroke that runs
    // it. The guard scans the source and rejects before the parser is invoked.
    const deep = "(".repeat(40) + "x" + ")".repeat(40);
    const start = performance.now();
    const result = compileMathInput(deep);
    // A hang would blow the test timeout; this pins it to the O(n) scan instead.
    expect(performance.now() - start).toBeLessThan(200);
    expect(result.latex).toBeNull();
    expect(result.error).toMatch(/nested too deeply/);
  });

  it("does not let an unterminated quote hide pathological nesting", () => {
    const hostile = `"${"(".repeat(40)}`;
    const start = performance.now();
    const result = compileMathInput(hostile);

    expect(performance.now() - start).toBeLessThan(50);
    expect(result.latex).toBeNull();
    expect(result.error).toMatch(/nested too deeply/);
  });

  it("ignores brackets inside complete quoted text like the parser does", () => {
    expect(compileMathInput('"((((((((((((((((((((" + x').latex).not.toBeNull();
  });

  it("refuses ambiguous absolute-value bars before parser backtracking", () => {
    const hostile = "|x|".repeat(20);
    const start = performance.now();
    const result = compileMathInput(hostile);

    expect(performance.now() - start).toBeLessThan(50);
    expect(result.latex).toBeNull();
    expect(result.error).toMatch(/ambiguous \| delimiters/);
  });

  it("accepts ordinary absolute values and norms", () => {
    expect(compileMathInput("|x| + |y|").latex).not.toBeNull();
    expect(compileMathInput("||A||").latex).not.toBeNull();
  });

  it("adapts valid reference outputs that KaTeX does not name", () => {
    expect(compileMathInput(">->>").latex).toContain("\\twoheadrightarrow");
    expect(compileMathInput("twoheadrightarrowtail").latex).toContain(
      "\\rightarrowtail",
    );
    expect(compileMathInput("Sin(x)").latex).toContain("\\operatorname{Sin}");
    expect(compileMathInput("Log(x)").latex).toContain("\\operatorname{Log}");
  });

  it("still accepts the nesting depth real expressions reach", () => {
    // Grouped fractions and matrices nest a handful of levels — that has to keep
    // compiling; only the absurd is refused.
    expect(compileMathInput("(((a + b)))").latex).not.toBeNull();
    expect(compileMathInput("[[a,b],[c,d]]").latex).not.toBeNull();
    expect(compileMathInput("((((((x))))))").latex).not.toBeNull();
  });

  it("accepts the worst expansion throughout the safe parser budget", () => {
    const worstCase = "or".repeat(MAX_ASCIIMATH_INPUT_LENGTH / 2);
    expect(compileMathInput(worstCase).latex).not.toBeNull();
    expect(compileMathInput(worstCase).latex!.length).toBeLessThanOrEqual(
      MAX_MATH_LATEX_LENGTH,
    );
  });

  it("refuses direct LaTeX too long for the baked field", () => {
    const overrun = compileMathInput(`\\${"a".repeat(MAX_MATH_LATEX_LENGTH)}`);
    expect(overrun.latex).toBeNull();
    expect(overrun.error).toMatch(/too long/);
  });
});

describe("compileMathInput validation", () => {
  it("counts nesting after text forms that consume an opening quote", () => {
    const nested = "(".repeat(30) + "x" + ")".repeat(30);
    for (const prefix of ['text(")', 'text ["]', 'text{"}', 'mbox (")', 'mbox["]', 'mbox{"}']) {
      expect(compileMathInput(prefix + nested + '"').error).toMatch(/nested too deeply/);
    }
    expect(compileMathInput('(")"'.repeat(30) + "x" + ")".repeat(30)).error).toMatch(/nested too deeply/);
  });

  it("bounds actual parser work even without the lexical guard", () => {
    expect(() => asciiMathToLatex("(".repeat(30) + "x" + ")".repeat(30))).toThrow(/too complex/);
    // A failed parse must not poison the shared parser for the next edit.
    expect(latexOf("a/b")).toBe("\\frac{a}{b}");
  });

  it("escapes literal text without interpreting it as LaTeX", () => {
    for (const input of ['"100% done"', 'text(100% done)', '"a_b"', '"a&b"', '"$5"', '"{x} # ~ ^"']) {
      expect(compileMathInput(input).error).toBeNull();
    }
    expect(latexOf('"100% done"')).toBe("\\text{100\\% done}");
    expect(latexOf('"\\href{https://example.com}{x}"')).toContain("\\textbackslash{}href");
    expect(latexOf('text["hello"]')).toBe('\\text{"hello"}');
  });

  it("supports uppercase functions with arguments, scripts, and roots", () => {
    for (const input of ["Sin x", "Sin^2(x)", "Log_2(x)", "Sqrt x", "Sqrt(x)"]) {
      expect(compileMathInput(input).error).toBeNull();
    }
    expect(latexOf("Sqrt(x)")).toBe("\\sqrt{x}");
    expect(latexOf("Sin^2(x)")).toContain("\\operatorname{Sin}^{2}");
  });

  it("pairs absolute values before applying fractions and sums", () => {
    expect(latexOf("|x|/|y|")).toBe("\\frac{\\left \\lvert x \\right \\rvert}{\\left \\lvert y \\right \\rvert}");
    expect(latexOf("|x| + |y|")).toBe("\\left \\lvert x \\right \\rvert + \\left \\lvert y \\right \\rvert");
    expect(latexOf("||A||/||B||")).toContain("\\frac");
    for (const input of ["|x+1|^2", "|(x+1)/y|", "{x | x > 0}", "[[a,|,b],[c,|,d]]", "|->", "|_x_|"]) {
      expect(compileMathInput(input).error).toBeNull();
    }
  });

  it("reads a bar after an operator as opening, not closing", () => {
    const abs = (inner: string) => `\\left \\lvert ${inner} \\right \\rvert`;
    expect(latexOf("|1/|n||")).toBe(abs(`\\frac{1}{${abs("n")}}`));
    expect(latexOf("|1-|x||")).toBe(abs(`1 - ${abs("x")}`));
    expect(latexOf("||x|-1|")).toBe(abs(`${abs("x")} - 1`));
    expect(latexOf("||x| - |y||")).toBe(abs(`${abs("x")} - ${abs("y")}`));
    // A bar spaced like an opener opens even after an operand.
    expect(latexOf("|a b |c||")).toBe(abs(`a b ${abs("c")}`));
    expect(latexOf("|x| |y|")).toBe(`${abs("x")} ${abs("y")}`);
  });

  it("leaves a bar with no partner to the reference grammar", () => {
    expect(latexOf("|a-|b|")).toBe(`| a - \\left \\lvert b \\right \\rvert`);
    expect(latexOf("{x | x > 0}")).toBe("\\left \\lbrace x \\mid x > 0 \\right \\rbrace");
    expect(latexOf("(a |b|)")).toBe("\\left ( a \\left \\lvert b \\right \\rvert \\right )");
  });

  it("emits every unary symbol as a command, never as spelled-out letters", () => {
    // `mathbf` once came out as `mathbf{v}`: no KaTeX error, just the italic
    // letters m-a-t-h-b-f on every peer's canvas.
    const spelledOut = new AsciiMathParser().unary_symbols
      // `f` and `g` are function letters by design.
      .filter(({ asciimath, func }) => !(func && asciimath.length === 1))
      .map(({ asciimath }) => [asciimath, latexOf(`${asciimath}(v)`)] as const)
      .filter(([asciimath, latex]) =>
        latex === null || new RegExp(`(^|[^\\\\{a-zA-Z])${asciimath}\\{`).test(latex));
    expect(spelledOut).toEqual([]);
    expect(latexOf("mathbf(v)")).toBe("\\mathbf{v}");
    expect(latexOf("mathsf(v)")).toBe("\\mathsf{v}");
  });

  it("validates using the requested display mode", () => {
    const input = String.raw`\begin{align}x&=1\end{align}`;
    expect(compileMathInput(input, "latex", true).error).toBeNull();
    expect(compileMathInput(input, "latex", false).error).not.toBeNull();
  });

  it("refuses LaTeX that would render as an error on every peer's canvas", () => {
    // Each of these is a state you pass through while typing \frac{1}{2}.
    for (const partial of ["\\fra", "\\frac{1", "\\frac{1}{"]) {
      const result = compileMathInput(partial);
      expect(result.latex).toBeNull();
      expect(result.error).toBeTruthy();
      // The caller keeps the last good LaTeX, so nothing blanks mid-edit.
    }
  });

  it("reports the failure without KaTeX's column marker", () => {
    // The raw message repeats the source with combining characters marking the
    // column, which does not survive a one-line strip.
    const error = compileMathInput("\\fra").error!;
    expect(error).not.toMatch(/^KaTeX parse error/);
    expect(error).not.toMatch(/at position/);
    expect(error).toMatch(/Undefined control sequence/);
  });

  it("still publishes anything KaTeX can render", () => {
    expect(compileMathInput("\\frac{1}{2}").latex).toBe("\\frac{1}{2}");
    expect(compileMathInput("(a+10)/(b-10)").latex).toBe("\\frac{a + 10}{b - 10}");
  });

  it("rejects trust-gated commands instead of publishing error-red markup", () => {
    for (const input of [
      "\\href{https://example.com}{x}",
      "\\url{https://example.com}",
      "\\htmlClass{danger}{x}",
      "\\includegraphics{https://example.com/a.png}",
    ]) {
      const result = compileMathInput(input);
      expect(result.latex).toBeNull();
      expect(result.error).toMatch(/not allowed/);
    }
  });
});
