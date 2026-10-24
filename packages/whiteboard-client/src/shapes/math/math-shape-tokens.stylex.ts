/**
 * The math shape's themeable surface.
 *
 * The shape draws inside tldraw's canvas, whose colour mode is tldraw's to
 * decide — the `tl-theme__dark` class lands on an element tldraw owns. StyleX
 * cannot key off that class: `when.ancestor` resolves against a marker class
 * StyleX itself generated, and there is no way to mark a node another library
 * renders.
 *
 * So the shape carries its own palette instead. `MathShapeComponent` reads
 * tldraw's dark-mode signal and applies `mathDark` to the shape's root, which
 * re-points every variable below for that subtree. The values here are the
 * light board; `mathDark` in `math-shape-util.tsx` holds the dark ones.
 *
 * The board is light-only today (no `inferDarkMode`, no `colorScheme` on the
 * `<Tldraw>` mount), so the dark values are unreachable until that changes —
 * which is the point. Turning the board dark stays a one-line change instead
 * of becoming a math-specific bug.
 */
import * as stylex from "@stylexjs/stylex";

import { ink, neutral, surface, violet } from "@orbmeet/ui/tokens/colors.stylex";
import { shadows } from "@orbmeet/ui/tokens/shadows.stylex";

export const mathColors = stylex.defineVars({
  /** Body text: the rendered expression and the editor's input. */
  text: ink.strong,
  /** The "rendering…" placeholder, a step quieter than the expression. */
  mutedText: neutral.n700,
  /** The shape's card and the editor popover share one ground. */
  surface: `color-mix(in oklab, ${surface.raised} 98%, transparent)`,
  shapeBorder: neutral.n300,
  shapeShadow: shadows.lift2,
  editorBorder: violet.v300,
  /** The display/inline mode toggle. */
  modeBorder: violet.v200,
  modeSurface: violet.v50,
  modeSurfaceHover: violet.v100,
  modeText: violet.v700,
});
