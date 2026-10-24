import AsciiMathParser from "asciimath2tex";
import { readAsciiMathText } from "./asciimath-text";
import { pairBars, type BarLexer, type BarPair, type BarTokenRole } from "./asciimath-bars";

/** Bound actual grammar work, including backtracking that a lexical scan misses. */
const MAX_PARSE_STEPS = 2_048;

/**
 * Capitalised function names have no KaTeX macro of their own, and `Sqrt` has
 * no capital form at all.
 */
const CAPITALISED_FUNCTIONS =
  /^(Sin|Cos|Tan|Arcsin|Arccos|Arctan|Sinh|Cosh|Tanh|Cot|Sec|Csc|Log|Ln)$/;

type Token = { end: number; pos: number } | undefined;

class MathParser extends AsciiMathParser {
  private steps = 0;
  /** Opening bar → its closing bar, decided before the grammar runs. */
  private bars = new Map<number, BarPair>();
  /** Closing bars of the pairs currently being parsed; nothing may consume them. */
  private readonly barriers = new Set<number>();

  constructor() {
    super();
    // Adapt symbol definitions, not the resulting LaTeX: argument shape and
    // scripts must not affect whether a function name is supported.
    for (const symbol of this.unary_symbols) {
      if (CAPITALISED_FUNCTIONS.test(symbol.asciimath)) {
        symbol.tex = `\\operatorname{${symbol.asciimath}}`;
      } else if (symbol.asciimath === "Sqrt") {
        symbol.tex = "\\sqrt";
      } else if (symbol.atname === "mathvariant" && !symbol.tex.startsWith("\\")) {
        // Font commands are always LaTeX commands. The reference table spells
        // `mathbf` and `mathsf` without their backslash, which KaTeX happily
        // renders as the italic letters m-a-t-h-b-f instead of failing.
        symbol.tex = `\\${symbol.tex}`;
      }
    }
  }

  override parse(input: string): string {
    this.steps = 0;
    this.barriers.clear();
    this.input(input);
    this.bars = pairBars(input, this.barLexer);
    return super.parse(input);
  }

  private readonly barLexer: BarLexer = {
    textEnd: (pos) => readAsciiMathText(this._source as string, pos)?.end ?? null,
    symbolAt: (pos) => {
      const source = this._source as string;
      const candidates: Array<[Token, BarTokenRole | null]> = [
        [this.left_bracket(pos), "open"],
        [this.right_bracket(pos), "close"],
        [this.other_constant(pos), null],
      ];
      let best: { end: number; role: BarTokenRole } | null = null;
      for (const [token, role] of candidates) {
        // `exact` skips leading space and stray backslashes; only a token that
        // starts right here describes this position.
        if (!token || token.pos !== pos || (best && token.end <= best.end)) continue;
        if (role) {
          best = { end: token.end, role };
          continue;
        }
        // Other symbols matter only when they contain a bar, which then belongs
        // to the symbol. One ending in a bar (`~|`, `__|`) closes a term.
        const text = source.slice(pos, token.end);
        if (!text.includes("|")) continue;
        best = { end: token.end, role: text.endsWith("|") ? "operand" : "operator" };
      }
      return best;
    },
  };

  override simple(pos = 0): ReturnType<AsciiMathParser["simple"]> {
    if (++this.steps > MAX_PARSE_STEPS) {
      throw new Error("That AsciiMath expression is too complex to parse safely.");
    }
    if (this.barriers.has(this.strip_space(pos))) return undefined;
    // Text is opaque. Do not also explore bracket/unary alternatives inside it.
    return this.text(pos) ?? super.simple(pos);
  }

  override text(pos = 0): ReturnType<AsciiMathParser["text"]> {
    const start = this.strip_space(pos);
    const token = readAsciiMathText(this._source as string, start);
    // The dependency's declarations omit undefined for unmatched productions.
    if (!token) return undefined!;
    const text = this.escape_text(token.text);
    return { tex: `\\text{${text}}`, text, pos: start, end: token.end, ttype: "text" };
  }

  override escape_text(input: string): string {
    const escapes: Record<string, string> = {
      "\\": "\\textbackslash{}",
      "~": "\\textasciitilde{}",
      "^": "\\textasciicircum{}",
    };
    return input.replace(/[\\{}%$&#_^~]/g, (char) => escapes[char] ?? `\\${char}`);
  }

  /**
   * Parses a bar pair decided by `pairBars` as one bracket. The closing bar is
   * a barrier while its contents parse, so nothing inside can consume it; if
   * the contents still do not reach it, the reference grammar gets the bar.
   */
  override bracketed_expression(pos = 0): ReturnType<AsciiMathParser["bracketed_expression"]> {
    const start = this.strip_space(pos);
    const pair = this.bars.get(start);
    if (!pair) return super.bracketed_expression(pos);

    const { close, width } = pair;
    this.barriers.add(close);
    let middle: ReturnType<AsciiMathParser["expression_list"]>;
    try {
      middle = this.expression_list(start + width);
    } finally {
      this.barriers.delete(close);
    }
    if (!middle || this.strip_space(middle.end) !== close) {
      return super.bracketed_expression(pos);
    }

    const delimiter = width === 2 ? "||" : "|";
    const left = width === 2 ? "\\Vert" : "\\lvert";
    const right = width === 2 ? "\\Vert" : "\\rvert";
    return {
      tex: `\\left ${left} ${middle.tex} \\right ${right}`,
      pos: start,
      end: close + width,
      bracket: true,
      ttype: "bracket",
      middle,
      // Plain bracket halves, not `leftright_bracket`: the reference grammar's
      // mid-expression rule would otherwise turn `(a |b|)` into `a \mid b`.
      left: { asciimath: delimiter, tex: left, pos: start, end: start + width, ttype: "left_bracket" },
      right: { asciimath: delimiter, tex: right, pos: close, end: close + width, ttype: "right_bracket" },
    };
  }
}

const parser = new MathParser();

/**
 * `asciimath2tex` follows the reference symbol table more closely than KaTeX's
 * command table does. Normalise the handful of valid reference outputs that
 * KaTeX cannot consume directly.
 */
function normalizeReferenceLatex(latex: string): string {
  return latex.replaceAll(
    "\\twoheadrightarrowtail",
    "\\mathrel{\\twoheadrightarrow\\mkern-15mu\\rightarrowtail}",
  );
}

/** Transpiles AsciiMath with the application's single parser instance. */
export function asciiMathToLatex(input: string): string {
  return normalizeReferenceLatex(parser.parse(input));
}

