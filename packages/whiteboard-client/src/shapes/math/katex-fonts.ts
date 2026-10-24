import { defaultAddFontsFromNode, type RichTextFontVisitor, type TLFontFace } from "tldraw";
import { INLINE_MATH_NODE } from "@orbmeet/whiteboard-core/math/constants";
import amsRegular from "katex/dist/fonts/KaTeX_AMS-Regular.woff2?url";
import caligraphicRegular from "katex/dist/fonts/KaTeX_Caligraphic-Regular.woff2?url";
import frakturRegular from "katex/dist/fonts/KaTeX_Fraktur-Regular.woff2?url";
import mainBold from "katex/dist/fonts/KaTeX_Main-Bold.woff2?url";
import mainItalic from "katex/dist/fonts/KaTeX_Main-Italic.woff2?url";
import mainRegular from "katex/dist/fonts/KaTeX_Main-Regular.woff2?url";
import mathBoldItalic from "katex/dist/fonts/KaTeX_Math-BoldItalic.woff2?url";
import mathItalic from "katex/dist/fonts/KaTeX_Math-Italic.woff2?url";
import sansSerifRegular from "katex/dist/fonts/KaTeX_SansSerif-Regular.woff2?url";
import scriptRegular from "katex/dist/fonts/KaTeX_Script-Regular.woff2?url";
import size1Regular from "katex/dist/fonts/KaTeX_Size1-Regular.woff2?url";
import size2Regular from "katex/dist/fonts/KaTeX_Size2-Regular.woff2?url";
import size3Regular from "katex/dist/fonts/KaTeX_Size3-Regular.woff2?url";
import size4Regular from "katex/dist/fonts/KaTeX_Size4-Regular.woff2?url";
import typewriterRegular from "katex/dist/fonts/KaTeX_Typewriter-Regular.woff2?url";

/**
 * The KaTeX faces an equation is set in, declared to tldraw.
 *
 * tldraw measures rich text once and caches the box, re-measuring only when a
 * font the shape declared finishes loading. KaTeX's faces come from its own
 * stylesheet and load lazily on first use, so an undeclared equation is
 * measured against a fallback face and its box never catches up. Declaring
 * them lets tldraw load them first and re-measure once they land.
 *
 * Weights and styles mirror `katex.min.css`, so tldraw finds and loads the
 * faces that stylesheet already registered instead of adding duplicates.
 */
const face = (family: string, url: string, weight = "400", style = "normal"): TLFontFace => ({
  family: `KaTeX_${family}`,
  src: { url, format: "woff2" },
  weight,
  style,
});

const MAIN = face("Main", mainRegular);
const MATH = face("Math", mathItalic, "400", "italic");
const AMS = face("AMS", amsRegular);
// Stretchy brackets — every AsciiMath bracket is emitted as `\left … \right`.
const SIZES = [size1Regular, size2Regular, size3Regular, size4Regular].map((url, index) =>
  face(`Size${index + 1}`, url),
);
const BASE_FACES: readonly TLFontFace[] = [MAIN, MATH, AMS, ...SIZES];

/** Faces only some commands reach, keyed by a pattern over the LaTeX. */
const COMMAND_FACES: ReadonlyArray<readonly [RegExp, readonly TLFontFace[]]> = [
  [/\\(?:mathbf|boldsymbol|bm|textbf|bf)\b/, [face("Main", mainBold, "700"), face("Math", mathBoldItalic, "700", "italic")]],
  [/\\(?:mathit|textit|emph|it)\b/, [face("Main", mainItalic, "400", "italic")]],
  [/\\mathcal\b/, [face("Caligraphic", caligraphicRegular)]],
  [/\\mathfrak\b/, [face("Fraktur", frakturRegular)]],
  [/\\(?:mathsf|textsf)\b/, [face("SansSerif", sansSerifRegular)]],
  [/\\mathscr\b/, [face("Script", scriptRegular)]],
  [/\\(?:mathtt|texttt)\b/, [face("Typewriter", typewriterRegular)]],
];

/** Every KaTeX face `latex` is likely to be set in. */
export function getKatexFontFaces(latex: string): TLFontFace[] {
  const faces = [...BASE_FACES];
  for (const [pattern, extra] of COMMAND_FACES) {
    if (pattern.test(latex)) faces.push(...extra);
  }
  return faces;
}

/** tldraw's font visitor, plus the faces of each equation in the text. */
export const addWhiteboardFontsFromNode: RichTextFontVisitor = (node, state, addFont) => {
  if (node.type.name !== INLINE_MATH_NODE) return defaultAddFontsFromNode(node, state, addFont);
  const latex = typeof node.attrs.latex === "string" ? node.attrs.latex : "";
  for (const font of getKatexFontFaces(latex)) addFont(font);
  return state;
};
