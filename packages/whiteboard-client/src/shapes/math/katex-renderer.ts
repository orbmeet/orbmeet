import katex, { type KatexOptions } from "katex";
import "katex/dist/katex.min.css";

function rejectUntrustedCommand(context: { command: string }): never {
  throw new Error(`${context.command} is not allowed in a shared math expression`);
}

/**
 * `latex` arrives from the synced store, so any peer can author it. The trust
 * callback blocks \href and the \html* family; maxExpand and maxSize bound what one
 * expression can cost in macro expansion and layout (without maxSize,
 * \rule{5000em}{5000em} renders at exactly that size). strict is off because a
 * whiteboard collects pasted Unicode, and warning about it on every keystroke
 * only fills the console.
 */
const KATEX_OPTIONS = {
  output: "htmlAndMathml",
  // KaTeX normally paints trust-denied commands red without throwing, even
  // with throwOnError. Throwing from the documented trust callback makes the
  // validation contract honest while still denying every active command.
  trust: rejectUntrustedCommand,
  strict: false,
  maxExpand: 1_000,
  maxSize: 100,
} satisfies KatexOptions;

export function renderKatex(
  latex: string,
  displayMode = true,
): string | null {
  try {
    return katex.renderToString(latex, {
      ...KATEX_OPTIONS,
      displayMode,
      throwOnError: true,
    });
  } catch {
    return null;
  }
}

/**
 * KaTeX's own message, trimmed to the part worth showing in a one-line strip.
 * The full text repeats the source with combining characters marking the
 * offending column, which does not survive a 9px sans-serif.
 */
function readableKatexError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const trimmed = message
    .replace(/^KaTeX parse error:\s*/, "")
    .split(" at position ")[0]
    .trim();
  return trimmed || "Could not render that expression";
}

/**
 * Why the expression will not render, or null when it renders cleanly.
 * Compilation gates on this so LaTeX that would render as red error text never
 * reaches the synced record, where every peer would watch it.
 */
export function getKatexError(latex: string, displayMode = true): string | null {
  try {
    katex.renderToString(latex, {
      ...KATEX_OPTIONS,
      displayMode,
      throwOnError: true,
    });
    return null;
  } catch (error) {
    return readableKatexError(error);
  }
}
