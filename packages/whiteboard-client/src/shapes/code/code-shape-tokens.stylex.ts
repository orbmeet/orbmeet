/**
 * The code shape's themeable surface.
 *
 * Same arrangement as `math-shape-tokens.stylex.ts`, and for the same reason:
 * the shape draws inside tldraw's canvas, whose colour mode tldraw owns via a
 * class StyleX cannot key off. So the shape carries its own palette, and
 * `CodeShapeComponent` applies `codeDark` to its root when tldraw reports a
 * dark board.
 *
 * These are the light-board values, built from the shared palette rather than
 * an editor theme's own hexes. A code cell on a light board is a quiet inset
 * well on white paper — `surface.sunken` exists for exactly that — not a strip
 * of midnight IDE chrome dropped onto the desk. The dark values live in
 * `code-shape-theme.ts` and are unreachable until the board itself goes dark.
 */
import * as stylex from "@stylexjs/stylex";

import { border, danger, ink, neutral, success, surface } from "@orbmeet/ui/tokens/colors.stylex";

export const codeColors = stylex.defineVars({
  /** The cell's ground, and the gutter/header band a step darker than it. */
  surface: surface.sunken,
  chrome: neutral.n100,
  shapeBorder: border.base,

  /** Source text, and the line numbers beside it. */
  text: ink.strong,
  lineNumber: ink.muted,

  /** Language picker: an input on the chrome band. */
  controlSurface: surface.raised,
  controlBorder: border.base,

  /** Run: the one filled control on the shape. */
  runSurface: ink.strong,
  runSurfaceHover: neutral.n700,
  runText: ink.onDark,

  /** Clear-output: quiet until pointed at. */
  quietText: ink.muted,
  quietHover: neutral.n200,

  /** Status pills. Idle carries no fill; the other two do. */
  statusIdleText: ink.muted,
  statusSuccessText: success.s700,
  statusSuccessSurface: success.s50,
  statusErrorText: danger.d700,
  statusErrorSurface: danger.d50,

  /** The output tray: a second, deeper well below the editor. */
  outputSurface: neutral.n100,
  outputChrome: neutral.n150,
  outputText: ink.body,
  outputErrorText: danger.d700,
});
