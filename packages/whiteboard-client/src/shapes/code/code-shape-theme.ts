import * as stylex from "@stylexjs/stylex";

import { danger, ink, neutral, success } from "@orbmeet/ui/tokens/colors.stylex";
import { codeColors } from "./code-shape-tokens.stylex";

/** The dark palette applied when tldraw reports that the board is dark. */
export const codeDark = stylex.createTheme(codeColors, {
  surface: neutral.n900,
  chrome: neutral.n950,
  shapeBorder: neutral.n700,

  text: neutral.n100,
  lineNumber: neutral.n500,

  controlSurface: neutral.n800,
  controlBorder: neutral.n700,

  // Inverted against the light board, where Run is the dark fill: on a dark
  // board the one filled control is the light one.
  runSurface: neutral.n100,
  runSurfaceHover: neutral.n200,
  runText: ink.strong,

  quietText: neutral.n400,
  quietHover: neutral.n800,

  statusIdleText: neutral.n500,
  statusSuccessText: success.s300,
  statusSuccessSurface: `color-mix(in oklab, ${success.s500} 18%, transparent)`,
  statusErrorText: danger.d300,
  statusErrorSurface: `color-mix(in oklab, ${danger.d500} 18%, transparent)`,

  outputSurface: neutral.n950,
  outputChrome: neutral.n800,
  outputText: neutral.n300,
  outputErrorText: danger.d300,
});

/**
 * Literal colours for the SVG export path, which paints into a standalone
 * document where the shape's custom properties do not resolve. `renderMathSvg`
 * inlines its two colours for the same reason; this shape needs more than two,
 * so they are named here instead of scattered through the render function.
 */
export const CODE_SVG_PALETTE = {
  light: {
    surface: "#f1f5f9",
    chrome: "#e2e8f0",
    border: "#e2e8f0",
    text: "#0f172a",
    muted: "#64748b",
    outputSurface: "#e9eef4",
    errorText: "#b91c1c",
  },
  dark: {
    surface: "#0f172a",
    chrome: "#020617",
    border: "#334155",
    text: "#f1f5f9",
    muted: "#94a3b8",
    outputSurface: "#020617",
    errorText: "#fca5a5",
  },
} as const;

export type CodeSvgPalette = (typeof CODE_SVG_PALETTE)[keyof typeof CODE_SVG_PALETTE];
