import * as stylex from "@stylexjs/stylex";

import { ink, neutral, violet } from "@orbmeet/ui/tokens/colors.stylex";
import { scrim } from "@orbmeet/ui/tokens/wash.stylex";
import { mathColors } from "./math-shape-tokens.stylex";

/** The dark palette applied when tldraw reports that the board is dark. */
export const mathDark = stylex.createTheme(mathColors, {
  text: neutral.n100,
  mutedText: neutral.n400,
  surface: `color-mix(in oklab, ${ink.strong} 98%, transparent)`,
  shapeBorder: neutral.n700,
  shapeShadow: `0 5px 18px ${scrim.wash}`,
  editorBorder: violet.v700,
  modeBorder: violet.v800,
  // The old dark mode did not distinguish hover here; preserve that choice.
  modeSurface: `color-mix(in oklab, ${violet.v900} 35%, transparent)`,
  modeSurfaceHover: `color-mix(in oklab, ${violet.v900} 35%, transparent)`,
  modeText: violet.v200,
});
