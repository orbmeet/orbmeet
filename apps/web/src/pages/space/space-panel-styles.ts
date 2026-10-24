import * as stylex from "@stylexjs/stylex";
import { ink, neutral } from "@orbmeet/ui/tokens/colors.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { leading, text } from "@orbmeet/ui/tokens/typography.stylex";

/** Styles shared by more than one Space detail panel. */
export const panelStyles = stylex.create({
  panelNote: {
    marginTop: space.s0_5,
    marginBottom: 0,
    fontSize: text.xs,
    lineHeight: leading.xs,
    color: ink.muted,
  },
  pagerFoot: { paddingTop: space.s2, textAlign: "center" },

  activityGlyph: { color: neutral.n500 },
  quiet: { margin: 0, fontSize: text.xs, lineHeight: leading.xs, color: ink.muted },
  spacedTop: { marginTop: space.s3 },
});
