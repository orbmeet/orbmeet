/**
 * Decides which `|` bars in an AsciiMath source open an absolute value (or a
 * `||` norm) and which close one, before the grammar runs.
 *
 * A bar is its own mirror image, so the grammar alone cannot tell `|a|` from
 * `a|b`, and the reference parser's backtracking guesses wrong in ordinary
 * input like `|1/|n||`. People read bars from context instead, and this does
 * the same, left to right, in one pass:
 *
 * - A bar can only close when a bar is open in the same bracket group and the
 *   term before it is finished — it follows an operand, not an operator. That
 *   is what makes the second bar of `|1/|n||` an opener: it follows `/`.
 * - When a bar could close but is spaced like an opener — space before it, an
 *   operand right after it, as in `|a b |c||` — the spacing wins.
 * - Anything else opens. Bars left open when their group ends stay unpaired
 *   and fall back to the reference grammar, which is what keeps set-builder
 *   bars (`{x | x > 0}`) and matrix column bars working.
 */

export interface BarPair {
  /** Source index of the closing bar. */
  close: number;
  /** 1 for `|…|`, 2 for `||…||`. */
  width: 1 | 2;
}

export type BarTokenRole = "open" | "close" | "operator" | "operand";

export interface BarLexer {
  /** End of an opaque text form (`"…"`, `text(…)`) starting here, or null. */
  textEnd(pos: number): number | null;
  /**
   * A bracket or multi-character symbol starting here, per the grammar's own
   * tables: `(:` and `|:` open a group, `:)` and `:|` close one, and symbols
   * such as `|->` or `:|:` are operators whose bars are not delimiters. Plain
   * characters are left to the scan.
   */
  symbolAt(pos: number): { end: number; role: BarTokenRole } | null;
}

type Previous = "boundary" | "operator" | "operand";

/** Characters after which a term is still waiting for its right-hand side. */
const OPERATOR_CHARACTERS = new Set("+-*/=<>^_:~,;");
const OPENING_CHARACTERS = new Set("([{");
const CLOSING_CHARACTERS = new Set(")]}");
const OPERAND_START = /[A-Za-z0-9(\[{"\\]/;
const SPACE = /\s/;

/** Pairs every bar it can, keyed by the source index of the opening bar. */
export function pairBars(source: string, lexer: BarLexer): Map<number, BarPair> {
  const pairs = new Map<number, BarPair>();
  // Open bars per bracket group, innermost group last.
  const groups: Array<Array<{ pos: number; width: 1 | 2 }>> = [[]];
  let previous: Previous = "boundary";
  let index = 0;

  const openGroup = () => {
    groups.push([]);
    previous = "boundary";
  };
  const closeGroup = () => {
    if (groups.length > 1) groups.pop();
    else groups[0] = [];
    previous = "operand";
  };

  while (index < source.length) {
    const char = source[index];
    if (SPACE.test(char)) {
      index += 1;
      continue;
    }

    const textEnd = lexer.textEnd(index);
    if (textEnd !== null) {
      index = textEnd;
      previous = "operand";
      continue;
    }

    const symbol = lexer.symbolAt(index);
    if (symbol) {
      if (symbol.role === "open") openGroup();
      else if (symbol.role === "close") closeGroup();
      else previous = symbol.role;
      index = symbol.end;
      continue;
    }

    if (char === "|") {
      const open = groups[groups.length - 1];
      const top = open[open.length - 1];
      const width: 1 | 2 = source[index + 1] === "|" ? 2 : 1;
      const spacedAsOpener =
        index > 0 &&
        SPACE.test(source[index - 1]) &&
        OPERAND_START.test(source[index + width] ?? "");

      if (top && previous === "operand" && !spacedAsOpener) {
        open.pop();
        if (top.width > width) {
          // A lone bar cannot close a norm, so the opening `||` was two
          // absolute values opening at once: `||x|-1|`.
          open.push({ pos: top.pos, width: 1 });
          top.pos += 1;
          top.width = 1;
        }
        // A `||` can close a single bar with its first half: `|1/|n||` closes
        // `|n|` and then `|…|` around it.
        pairs.set(top.pos, { close: index, width: top.width });
        index += top.width;
        previous = "operand";
        continue;
      }

      open.push({ pos: index, width });
      index += width;
      previous = "boundary";
      continue;
    }

    if (OPENING_CHARACTERS.has(char)) openGroup();
    else if (CLOSING_CHARACTERS.has(char)) closeGroup();
    else if (char === ",") {
      // A comma separates list items and matrix cells; a bar never spans one.
      groups[groups.length - 1] = [];
      previous = "boundary";
    } else {
      previous = OPERATOR_CHARACTERS.has(char) ? "operator" : "operand";
    }
    index += 1;
  }

  return pairs;
}
