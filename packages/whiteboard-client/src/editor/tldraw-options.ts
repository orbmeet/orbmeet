import { tipTapDefaultExtensions, type TldrawOptions } from "tldraw";
import { InlineMathExtension } from "../shapes/math/inline-math-extension";
import { addWhiteboardFontsFromNode } from "../shapes/math/katex-fonts";

/**
 * The rich-text extension list every whiteboard editor runs: tldraw's defaults
 * plus the inline math node.
 *
 * TipTap's Typography extension is filtered out. tldraw 5.5.0 added it to its
 * defaults, and its input rules rewrite characters while the author types —
 * `^2` becomes `²`, straight quotes curl, `--` becomes an en dash — so the
 * math scanner would receive mangled ASCII (`$x^2$` typed, `$x²$` scanned) and
 * store corrupt equations. The math input path needs the characters the author
 * actually typed.
 */
export const WHITEBOARD_TIPTAP_EXTENSIONS = [
  ...tipTapDefaultExtensions.filter((extension) => extension.name !== "typography"),
  InlineMathExtension,
];

/**
 * Orb Meet models meeting pages as frame shapes on a single native tldraw page.
 * Keep tldraw's own page system disabled everywhere this document is mounted.
 */
export const WHITEBOARD_TLDRAW_OPTIONS = {
  maxPages: 1,
  // Locked shapes stay protected, but can still be inspected and selected.
  selectLockedShapes: true,
  // Allow right-click + drag to pan the canvas on desktop (mouse) users.
  // Without this, mouse users in writing mode can only pan by switching tools first.
  // A static right-click still opens the context menu at the release position.
  rightClickPanning: true,
  // Every whiteboard document can persist inline math inside an ordinary
  // tldraw rich-text shape. This belongs in the shared mount options, not only
  // the live editor hook: frozen Meeting recaps, handoffs, and hidden PDF
  // renderers deserialize the exact same document records.
  text: {
    // tldraw replaces the extension list wholesale rather than merging it, so
    // retain its defaults alongside the custom node.
    tipTapConfig: {
      extensions: WHITEBOARD_TIPTAP_EXTENSIONS,
    },
    // Declares each equation's KaTeX faces, so text is measured once they load.
    addFontsFromNode: addWhiteboardFontsFromNode,
  },
} satisfies Partial<TldrawOptions>;
