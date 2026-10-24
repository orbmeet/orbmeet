import { accent, border, ink, neutral, surface } from "@orbmeet/ui/tokens/colors.stylex";
import { disclosure } from "@orbmeet/ui/tokens/markers.stylex";
import { bp, env } from "@orbmeet/ui/tokens/media.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { leading, text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";

/** Base UI marks a trigger whose panel is open with this. */
const PANEL_OPEN = ":is([data-panel-open])";

/**
 * The pricing FAQ, shared by the interactive accordion and the `<details>`
 * fallback the server renders before it hydrates, so the two cannot drift.
 *
 * Each question is its own hairline-bordered item. The trigger is a native
 * `<button>` (or `<summary>`), so it carries an explicit reset — without one it
 * rendered as a grey, black-bordered browser button.
 */
export const faq = stylex.create({
  grid: {
    display: "grid",
    gap: space.s3,
    gridTemplateColumns: { default: "minmax(0, 1fr)", [bp.sm]: "repeat(2, minmax(0, 1fr))" },
    alignItems: "start",
  },
  item: {
    overflow: "hidden",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: {
      default: border.subtle,
      [env.hoverable]: { default: border.subtle, ":hover": border.strong },
    },
    borderRadius: radii.card,
    backgroundColor: surface.raised,
    transitionProperty: "border-color",
    transitionDuration: { default: "150ms", [env.reducedMotion]: "0s" },
  },
  trigger: {
    display: "flex",
    width: "100%",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.s3,
    margin: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    paddingInline: space.s5,
    paddingBlock: space.s4,
    fontFamily: "inherit",
    textAlign: "start",
    cursor: "pointer",
    listStyleType: "none",
    // A real pseudo-element, just missing from the rule's allowlist. It is how
    // Safari's default disclosure triangle is removed from the <summary>.
    // oxlint-disable-next-line @stylexjs/valid-styles
    "::-webkit-details-marker": { display: "none" },
  },
  question: {
    fontSize: text.sm,
    lineHeight: leading.sm,
    fontWeight: weight.semibold,
    color: {
      default: ink.strong,
      [env.hoverable]: { default: ink.strong, [stylex.when.ancestor(":hover")]: accent.a700 },
    },
  },
  chevron: {
    height: 16,
    width: 16,
    flexShrink: 0,
    color: {
      default: neutral.n400,
      [env.hoverable]: { default: neutral.n400, [stylex.when.ancestor(":hover")]: accent.a600 },
      [stylex.when.ancestor(PANEL_OPEN)]: accent.a600,
    },
    transform: {
      default: "rotate(0deg)",
      [stylex.when.ancestor(PANEL_OPEN)]: "rotate(180deg)",
      [stylex.when.ancestor(":is([open])", disclosure)]: "rotate(180deg)",
    },
  },
  answer: {
    margin: 0,
    paddingInline: space.s5,
    paddingBottom: space.s4,
    fontSize: text.sm,
    lineHeight: leading.relaxed,
    color: ink.muted,
  },
});
