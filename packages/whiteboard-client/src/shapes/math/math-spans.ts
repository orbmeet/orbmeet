/**
 * Finds the `$…$` and `$$…$$` equations in a run of text.
 *
 * This is the only definition of "what counts as delimited math". Typing and
 * every path that brings finished text in read through it, so they cannot
 * disagree about the same characters. The rules follow Pandoc's, which were
 * designed for prose that also talks about money:
 *
 * - An inline opening `$` must be followed by non-space, and its closing `$`
 *   preceded by non-space. Padding is accepted only when symmetric — `$ x^2 $`
 *   is deliberate, while `$5 and $` is two prices.
 * - A closing `$` must not be followed by a digit, so `$20,000 and $30,000`
 *   stays prose. The closer is also the first unescaped `$` after the opener;
 *   if that one cannot close, the opener is plain text.
 * - `\$` is a literal dollar everywhere.
 * - `$$` opens display math, which runs to the next `$$`. An unclosed `$$` is
 *   literal and never starts an inline equation at its second dollar.
 * - Inline math never spans a line break, and no math spans a `BOUNDARY` —
 *   which callers put wherever the text is not prose: an existing equation, a
 *   hard break, inline code.
 * - Content that is only an amount (`$5$`, `$1,000$`), or an amount opening a
 *   range (`$5-$`, as `$5-$10` reads while it is being typed), is a price.
 */

/** Stands in for anything that is not prose — an atom, a break, inline code. */
export const BOUNDARY = "￼";

export interface MathSpan {
  /** Index of the opening delimiter. */
  from: number;
  /** Index just past the closing delimiter. */
  to: number;
  /** Source between the delimiters, trimmed. */
  input: string;
  displayMode: boolean;
}

const SPACE = /\s/;
const DIGIT = /\d/;
const INLINE_BREAK = new RegExp(`[\\n${BOUNDARY}]`);

/**
 * `$5`, `$1,000` and `$3.99` between dollars are a price far more often than an
 * equation, and there is nothing to typeset in them either way.
 */
function looksLikePrice(input: string): boolean {
  return /^[\d.,\s]+[-–—]?$/.test(input);
}

/** Whether the `$` at `index` is escaped by an odd run of backslashes. */
function isEscaped(text: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor--) backslashes++;
  return backslashes % 2 === 1;
}

function nextDollar(text: string, from: number): number {
  for (let index = text.indexOf("$", from); index >= 0; index = text.indexOf("$", index + 1)) {
    if (!isEscaped(text, index)) return index;
  }
  return -1;
}

/** The unescaped `$$` that closes display math opened before `from`. */
function displayCloser(text: string, from: number): number {
  let closing = text.indexOf("$$", from);
  // An escaped first dollar is `\$` followed by a lone dollar, not a closer.
  while (closing >= 0 && isEscaped(text, closing)) closing = text.indexOf("$$", closing + 1);
  return closing;
}

function spanFor(text: string, from: number, to: number, width: 1 | 2): MathSpan | null {
  const input = text.slice(from + width, to - width).trim();
  if (!input || looksLikePrice(input)) return null;
  return { from, to, input, displayMode: width === 2 };
}

export interface ScanOptions {
  /**
   * `text` ends at the caret, with more still to be typed. An unclosed `$$` is
   * then display math in progress, not literal dollars, so nothing after it
   * is an equation yet — `$$"$5"$` must not close an inline `$5"$`.
   */
  atCaret?: boolean;
}

/** Every equation in `text`, in order and non-overlapping. */
export function scanMathSpans(text: string, { atCaret = false }: ScanOptions = {}): MathSpan[] {
  const spans: MathSpan[] = [];
  let index = nextDollar(text, 0);

  while (index >= 0) {
    if (text[index + 1] === "$") {
      const closing = displayCloser(text, index + 2);
      if (closing < 0 && atCaret) break;
      if (closing < 0 || text.slice(index + 2, closing).includes(BOUNDARY)) {
        // Unclosed, or closed only on the far side of something that is not
        // prose: both dollars are literal.
        index = nextDollar(text, index + 2);
        continue;
      }
      const span = spanFor(text, index, closing + 2, 2);
      if (span) spans.push(span);
      index = nextDollar(text, closing + 2);
      continue;
    }

    const closing = nextDollar(text, index + 1);
    if (closing < 0) break;
    const content = text.slice(index + 1, closing);
    const closes =
      text[closing + 1] !== "$" &&
      !INLINE_BREAK.test(content) &&
      SPACE.test(content[0]) === SPACE.test(content[content.length - 1]) &&
      !DIGIT.test(text[closing + 1] ?? "");
    if (closes) {
      // A delimited price (`$5$`) is still a matched pair: its closer must not
      // go on to open an equation with the next dollar.
      const span = spanFor(text, index, closing + 1, 1);
      if (span) spans.push(span);
      index = nextDollar(text, closing + 1);
    } else {
      // This dollar is prose; the next one may still open an equation.
      index = closing;
    }
  }

  return spans;
}
