/**
 * Form control surfaces.
 *
 * `Select` and `TimeZoneSelect` are different components built on different
 * Base UI primitives, but they are the same *control*: a 40px field with a
 * chevron on the right that opens a list, so they share one definition here
 * rather than two copies free to drift apart.
 */
import * as stylex from "@stylexjs/stylex";

import { accent, ink, neutral, surface } from "../tokens/colors.stylex";
import { env } from "../tokens/media.stylex";
import { duration, easing } from "../tokens/motion.stylex";
import { zIndex } from "../tokens/layers.stylex";
import { radii } from "../tokens/radii.stylex";
import { space } from "../tokens/space.stylex";
import { leading, text, weight } from "../tokens/typography.stylex";
import { scrimBase } from "../tokens/wash.stylex";

/** Base UI marks an open trigger with this, so it can wear the focus surface. */
const OPEN = ":is([data-popup-open])";

export const control = stylex.create({
  /**
   * The trigger of a select-like control.
   *
   * Focus is a border colour plus a ring-shaped box-shadow rather than an
   * outline: the popup aligns to this element's box, and an offset outline
   * would sit under the list.
   */
  trigger: {
    display: "flex",
    height: 40,
    width: "100%",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.s2,
    borderRadius: radii.field,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: {
      default: neutral.n300,
      [env.hoverable]: { default: neutral.n300, ":hover": neutral.n400 },
      ":focus-visible": accent.a400,
      [OPEN]: accent.a400,
    },
    backgroundColor: { default: surface.raised, ":disabled": neutral.n50 },
    paddingInline: space.s3,
    fontFamily: "inherit",
    fontSize: text.sm,
    lineHeight: leading.sm,
    color: ink.strong,
    textAlign: "start",
    userSelect: "none",
    cursor: { default: "pointer", ":disabled": "not-allowed" },
    opacity: { default: 1, ":disabled": 0.5 },
    outlineStyle: "none",
    boxShadow: {
      default: "none",
      ":focus-visible": `0 0 0 2px color-mix(in oklab, ${accent.a500} 20%, transparent)`,
      [OPEN]: `0 0 0 2px color-mix(in oklab, ${accent.a500} 20%, transparent)`,
    },
    transitionProperty: "border-color, box-shadow, background-color",
    transitionDuration: { default: duration.instant, [env.reducedMotion]: "0s" },
    transitionTimingFunction: easing.stiff,
  },

  /** The chevron. Flips when the popup is open, where the control says so. */
  triggerIcon: {
    flexShrink: 0,
    color: neutral.n500,
    display: "flex",
    transitionProperty: "transform",
    transitionDuration: { default: duration.instant, [env.reducedMotion]: "0s" },
  },
  triggerIconFlips: {
    transform: { default: "rotate(0deg)", [OPEN]: "rotate(180deg)" },
  },

  /** The trigger's displayed value, greyed while it is only a placeholder. */
  value: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: { default: "inherit", ":is([data-placeholder])": neutral.n400 },
  },

  /** A field label sitting above its control. */
  label: {
    marginBottom: space.s1_5,
    display: "block",
    fontSize: text.sm,
    lineHeight: leading.sm,
    fontWeight: weight.medium,
    color: neutral.n700,
  },

  /** The wrapper a label introduces, so the two stack instead of sitting side by side. */
  field: { width: "100%" },
});

const STARTING = ":is([data-starting-style])";
const ENDING = ":is([data-ending-style])";
const HIGHLIGHTED = ":is([data-highlighted])";
const SELECTED = ":is([data-selected])";
const SELECTED_HIGHLIGHTED = ":is([data-selected][data-highlighted])";
const DISABLED = ":is([data-disabled])";

/** The list a control opens. */
export const listbox = stylex.create({
  positioner: { zIndex: zIndex.popover, outlineStyle: "none" },
  popup: {
    borderRadius: radii.control,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: neutral.n200,
    backgroundColor: surface.raised,
    boxShadow: `0 12px 40px color-mix(in oklab, ${scrimBase.black} 15%, transparent)`,
    overflow: "hidden",
    transformOrigin: "var(--transform-origin)",
    opacity: { default: 1, [STARTING]: 0, [ENDING]: 0 },
    scale: { default: 1, [STARTING]: 0.95, [ENDING]: 0.95 },
    transitionProperty: "opacity, scale",
    transitionDuration: { default: duration.fast, [env.reducedMotion]: "0s" },
    transitionTimingFunction: easing.gentle,
  },
  /** Base UI publishes the trigger's box, so the list can match its width. */
  anchorWidth: { minWidth: "var(--anchor-width)" },
  matchAnchorWidth: { width: "var(--anchor-width)", maxWidth: "var(--available-width)" },

  list: {
    maxHeight: "var(--available-height)",
    overflowY: "auto",
    paddingBlock: space.s1,
    // A real CSS property, missing from the rule's allowlist.
    // oxlint-disable-next-line @stylexjs/valid-styles
    scrollPaddingBlock: space.s1,
  },
  listCapped: { maxHeight: "min(15rem, var(--available-height))", padding: space.s1 },

  /** A two-column row: indicator gutter, then label. */
  item: {
    display: "grid",
    gridTemplateColumns: "1rem 1fr",
    alignItems: "center",
    gap: space.s2,
    paddingInline: space.s3,
    paddingBlock: space.s2,
    fontSize: text.sm,
    lineHeight: leading.sm,
    color: { default: neutral.n700, [HIGHLIGHTED]: accent.a700 },
    backgroundColor: { default: "transparent", [HIGHLIGHTED]: accent.a50 },
    cursor: { default: "default", [DISABLED]: "not-allowed" },
    opacity: { default: 1, [DISABLED]: 0.5 },
    userSelect: "none",
    outlineStyle: "none",
  },
  /** A row whose label and trailing metadata sit at opposite ends. */
  itemSplit: {
    display: "flex",
    width: "100%",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.s3,
    borderRadius: radii.field,
    paddingInline: space.s3,
    paddingBlock: space.s2,
    textAlign: "start",
    fontSize: text.sm,
    lineHeight: leading.sm,
    color: { default: neutral.n700, [SELECTED]: accent.a800 },
    backgroundColor: {
      default: "transparent",
      [HIGHLIGHTED]: neutral.n50,
      [SELECTED]: accent.a50,
      // Explicitly keep selection above transient keyboard/pointer highlight.
      [SELECTED_HIGHLIGHTED]: accent.a50,
    },
    cursor: "default",
    outlineStyle: "none",
    transitionProperty: "color, background-color",
    transitionDuration: { default: duration.instant, [env.reducedMotion]: "0s" },
  },
  indicator: {
    gridColumnStart: "1",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: accent.a600,
  },
  itemText: { gridColumnStart: "2" },

  /** The scroll affordances a long list grows. */
  scrollArrow: {
    display: "flex",
    height: 20,
    width: "100%",
    cursor: "default",
    alignItems: "center",
    justifyContent: "center",
    color: neutral.n500,
  },

  empty: {
    // Base UI renders this element even when it has nothing to say, so the
    // padding has to collapse with the text rather than leave a blank strip.
    paddingInline: { default: space.s3, ":empty": 0 },
    paddingBlock: { default: space.s2_5, ":empty": 0 },
    fontSize: text.xs,
    lineHeight: leading.xs,
    color: neutral.n500,
  },

  /** A search field pinned to the top of a list. */
  searchRow: {
    position: "relative",
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: neutral.n100,
  },
  searchIcon: {
    pointerEvents: "none",
    position: "absolute",
    left: space.s3,
    top: "50%",
    transform: "translateY(-50%)",
    color: neutral.n400,
  },
  searchInput: {
    height: 40,
    width: "100%",
    backgroundColor: "transparent",
    borderWidth: 0,
    paddingLeft: space.s9,
    paddingRight: space.s3,
    fontFamily: "inherit",
    fontSize: text.sm,
    lineHeight: leading.sm,
    color: ink.strong,
    outlineStyle: "none",
    "::placeholder": { color: neutral.n400 },
  },
});
