import { describe, expect, it } from "vitest";
import { BOUNDARY, scanMathSpans, type ScanOptions } from "./math-spans";

/** The equations in `text`, as their source and whether they display. */
const equations = (text: string, options?: ScanOptions) =>
  scanMathSpans(text, options).map(({ input, displayMode }) => (displayMode ? `$$${input}$$` : input));

describe("scanMathSpans", () => {
  it("finds inline and display equations with their offsets", () => {
    expect(scanMathSpans("so $x^2$ and $$y$$.")).toEqual([
      { from: 3, to: 8, input: "x^2", displayMode: false },
      { from: 13, to: 18, input: "y", displayMode: true },
    ]);
  });

  it("reads prices as prose", () => {
    expect(equations("It cost $5 and $10")).toEqual([]);
    expect(equations("between $5-$10 a month")).toEqual([]);
    expect(equations("$5/$10")).toEqual([]);
    expect(equations("$20,000 and $30,000")).toEqual([]);
    expect(equations("$5 and $")).toEqual([]);
    // How `$5-$10` reads while it is being typed, before the digit arrives.
    expect(equations("$5-$")).toEqual([]);
    expect(equations("$5–$")).toEqual([]);
    // Only a number between the dollars is a price, and it still closes, so its
    // closer cannot go on to open an equation.
    expect(equations("$5$ and $1,000$ or $3.99$ $$5$$")).toEqual([]);
    expect(equations("$5$ and $x$")).toEqual(["x"]);
  });

  it("keeps an equation followed by prose", () => {
    expect(equations("$x$, then $y$.")).toEqual(["x", "y"]);
    expect(equations("$5x$ $-1$")).toEqual(["5x", "-1"]);
  });

  it("accepts symmetric padding only", () => {
    expect(equations("$ x^2 $")).toEqual(["x^2"]);
    expect(equations("$ x^2$")).toEqual([]);
    expect(equations("$x^2 $")).toEqual([]);
    expect(equations("$$ (a+10)/(b-10) $$")).toEqual(["$$(a+10)/(b-10)$$"]);
  });

  it("treats escaped dollars as content", () => {
    expect(equations(String.raw`$\$5x$`)).toEqual([String.raw`\$5x`]);
    expect(equations(String.raw`$x+\$`)).toEqual([]);
    expect(equations(String.raw`\$x$y$`)).toEqual(["y"]);
    expect(equations(String.raw`\\$x$`)).toEqual(["x"]);
  });

  it("never starts an inline equation inside unclosed display delimiters", () => {
    expect(equations("$$x^2$")).toEqual([]);
    expect(equations("$$")).toEqual([]);
    expect(equations("$$a$$ and $$b$$")).toEqual(["$$a$$", "$$b$$"]);
    expect(equations("$a$$b$$")).toEqual(["$$b$$"]);
  });

  it("reads an unclosed $$ at the caret as display math still being typed", () => {
    expect(equations('$$"$5"$', { atCaret: true })).toEqual([]);
    expect(equations('$a$ $$"$5"$', { atCaret: true })).toEqual(["a"]);
    // Finished text has no caret: the unclosed `$$` is literal.
    expect(equations("$$ and $x$")).toEqual(["x"]);
  });

  it("keeps inline equations on one line and display ones free to span lines", () => {
    expect(equations("$x\ny$")).toEqual([]);
    expect(equations("$x$\n$y$")).toEqual(["x", "y"]);
    expect(equations("$$a\n\nb$$")).toEqual(["$$a\n\nb$$"]);
  });

  it("never reaches across a boundary", () => {
    expect(equations(`${BOUNDARY}$b$`)).toEqual(["b"]);
    expect(equations(`$a ${BOUNDARY} b$`)).toEqual([]);
    expect(equations(`$$a${BOUNDARY}b$$`)).toEqual([]);
  });

  it("reads a dollar cut off by a boundary as prose, like one cut off by a line", () => {
    // A stray dollar before a hard break or inline code must not pair with a
    // dollar beyond it and swallow the equation that dollar opens.
    expect(equations(`see $ref${BOUNDARY}x$y$`)).toEqual(["y"]);
    expect(equations(`cost ${BOUNDARY} then $x$`)).toEqual(["x"]);
    expect(equations(`$$a${BOUNDARY}b$$ $c$`)).toEqual(["c"]);
  });

  it("ignores empty delimiters", () => {
    expect(equations("$ $ $$ $$")).toEqual([]);
  });
});
