/**
 * Shared style namespaces — the handful of treatments that recur across
 * enough components to be worth naming once.
 *
 * This is deliberately small. StyleX styles compose by merging, so a shared
 * namespace only earns its place when the *decision* is shared, not merely the
 * declarations: `focus.ring` is here because the app has one focus treatment
 * and it should be impossible to draw a different one by accident, whereas a
 * "flex row with a gap" namespace would just be a worse way of writing two
 * properties.
 */
import * as stylex from "@stylexjs/stylex";

import { accent, danger, ink, neutral, success, surface } from "../tokens/colors.stylex";
import { duration, easing } from "../tokens/motion.stylex";
import { env, safeArea } from "../tokens/media.stylex";
import { shadows } from "../tokens/shadows.stylex";
import { space } from "../tokens/space.stylex";
import { fonts, leading, text, tracking, weight } from "../tokens/typography.stylex";

/**
 * The app's focus treatment. One ring, drawn the same way everywhere.
 *
 * `:focus-visible` only — a mouse click on a button should not draw a ring.
 * `outlineOffset` rather than a box-shadow so the ring follows the border
 * radius of whatever it lands on without the element having to say so.
 */
export const focus = stylex.create({
  ring: {
    outlineColor: { default: "transparent", ":focus-visible": accent.a500 },
    outlineStyle: "solid",
    outlineWidth: 2,
    outlineOffset: 2,
  },
  /** For a control sitting on a dark or saturated ground. */
  ringOnDark: {
    outlineColor: { default: "transparent", ":focus-visible": `${surface.raised}` },
    outlineStyle: "solid",
    outlineWidth: 2,
    outlineOffset: 2,
  },
});

/** Layout primitives that carry a decision rather than just declarations. */
export const layout = stylex.create({
  /**
   * Removes an element from view but keeps it in the accessibility tree.
   * The clip-path variant, so a focused control inside it can still scroll
   * into view when it is un-hidden.
   */
  srOnly: {
    position: "absolute",
    width: 1,
    height: 1,
    margin: -1,
    padding: 0,
    overflow: "hidden",
    clipPath: "inset(50%)",
    whiteSpace: "nowrap",
    borderWidth: 0,
  },
  /** Fills its positioned ancestor. */
  fill: {
    position: "absolute",
    inset: 0,
  },
  /**
   * A flex or grid child that is allowed to shrink below its content size.
   * The single most common cause of a scroller that will not scroll.
   */
  minZero: {
    minWidth: 0,
    minHeight: 0,
  },
  /** One line, ellipsised. */
  truncate: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  /** A scroller with no visible scrollbar. */
  hideScrollbar: {
    scrollbarWidth: "none",
    "::-webkit-scrollbar": { display: "none" },
  },
  /** Decoration: never a hit target, never selectable. */
  decorative: {
    pointerEvents: "none",
    userSelect: "none",
  },
});

/**
 * The device's unsafe edges, as padding or as position.
 *
 * Each namespace applies the inset for the edge it names, so it is not
 * possible to pad the bottom with the top inset — the class that made that
 * mistake possible is gone.
 */
export const safe = stylex.create({
  padTop: { paddingTop: safeArea.top },
  padRight: { paddingRight: safeArea.right },
  padBottom: { paddingBottom: safeArea.bottom },
  padLeft: { paddingLeft: safeArea.left },
  padX: { paddingRight: safeArea.right, paddingLeft: safeArea.left },
  padY: { paddingTop: safeArea.top, paddingBottom: safeArea.bottom },
  padAll: {
    paddingTop: safeArea.top,
    paddingRight: safeArea.right,
    paddingBottom: safeArea.bottom,
    paddingLeft: safeArea.left,
  },
  inset: {
    top: safeArea.top,
    right: safeArea.right,
    bottom: safeArea.bottom,
    left: safeArea.left,
  },
  top: { top: safeArea.top },
  bottom: { bottom: safeArea.bottom },
});

/**
 * Vertical and horizontal stacks.
 *
 * These replace `space-y-*`, which is a different thing wearing the same name:
 * it sets a margin on every child but the first, so it breaks the moment a
 * child is conditionally rendered in first position, and it cannot be undone by
 * the child. A flex `gap` is owned by the container and has neither problem.
 */
export const stack = stylex.create({
  x1: { display: "flex", flexDirection: "column", gap: space.s1 },
  x2: { display: "flex", flexDirection: "column", gap: space.s2 },
  x3: { display: "flex", flexDirection: "column", gap: space.s3 },
  x4: { display: "flex", flexDirection: "column", gap: space.s4 },
  x6: { display: "flex", flexDirection: "column", gap: space.s6 },
  x8: { display: "flex", flexDirection: "column", gap: space.s8 },
});

/** Horizontal rows. `between` is the one that recurs enough to be named. */
export const row = stylex.create({
  x1: { display: "flex", alignItems: "center", gap: space.s1 },
  x2: { display: "flex", alignItems: "center", gap: space.s2 },
  x3: { display: "flex", alignItems: "center", gap: space.s3 },
  x4: { display: "flex", alignItems: "center", gap: space.s4 },
  between: { justifyContent: "space-between" },
});

/**
 * Type presets.
 *
 * Named for what the text *is*, not what size it is, so a whole tier can be
 * retuned in one place. A one-off size is still fine inline; these are for the
 * roles that repeat.
 */
export const type = stylex.create({
  sectionTitle: {
    fontFamily: fonts.heading,
    fontSize: text.lg,
    fontWeight: weight.semibold,
    lineHeight: leading.lg,
    letterSpacing: tracking.tight,
    color: ink.strong,
  },
  muted: {
    fontSize: text.sm,
    lineHeight: leading.sm,
    color: ink.muted,
  },
});

/**
 * Inline status messages — the sentence that appears under a control after it
 * has been used.
 *
 * Named by what they say rather than by colour, and given the same spacing, so
 * a failure and a confirmation occupy the same place and the layout does not
 * shift between them.
 */
export const status = stylex.create({
  error: {
    marginTop: space.s3,
    marginBottom: 0,
    fontSize: text.sm,
    lineHeight: leading.sm,
    color: danger.d600,
  },
  success: {
    marginTop: space.s3,
    marginBottom: 0,
    fontSize: text.sm,
    lineHeight: leading.sm,
    color: success.s600,
  },
  /** A quieter note in the same slot. */
  hint: {
    marginTop: space.s3,
    marginBottom: 0,
    fontSize: text.sm,
    lineHeight: leading.sm,
    color: ink.muted,
  },
  /** The same messages at footnote size, for a dense form. */
  small: { marginTop: space.s2, fontSize: text.xs, lineHeight: leading.xs },
  /** No leading gap, where the message is the first thing in its container. */
  flush: { marginTop: 0 },
});

/**
 * Transitions.
 *
 * Every one of these is parked under reduced motion. That is the replacement
 * for the global `* { transition-duration: 0.01ms !important }` rule the
 * stylesheet used to carry: StyleX has no global selector, and the blanket
 * rule was wrong anyway — it also froze the spinners.
 */
export const motion = stylex.create({
  /** Colour and border only. The default for a hover state. */
  tint: {
    transitionProperty: "color, background-color, border-color, box-shadow",
    transitionDuration: { default: duration.fast, [env.reducedMotion]: "0s" },
    transitionTimingFunction: easing.stiff,
  },
  /** Movement. For something that lifts, slides, or scales. */
  move: {
    transitionProperty: "transform, opacity, box-shadow",
    transitionDuration: { default: duration.base, [env.reducedMotion]: "0s" },
    transitionTimingFunction: easing.gentle,
  },
  /** A tinted control that also moves when pressed. */
  press: {
    transitionProperty: "color, background-color, border-color, box-shadow, transform",
    transitionDuration: { default: duration.fast, [env.reducedMotion]: "0s" },
    transitionTimingFunction: easing.stiff,
  },
  /** Everything. Use only where the set of animated properties really is open. */
  all: {
    transitionProperty: "all",
    transitionDuration: { default: duration.base, [env.reducedMotion]: "0s" },
    transitionTimingFunction: easing.stiff,
  },
});

/** Interactive affordances shared by every clickable thing. */
export const pressable = stylex.create({
  base: {
    appearance: "none",
    borderWidth: 0,
    backgroundColor: "transparent",
    // This lands on links as often as on buttons — every "button" that
    // navigates is an `<a>` — and a link keeps the UA underline unless told
    // not to. Without this the three pricing CTAs rendered as underlined
    // text inside a filled button, which reads as a styling bug.
    textDecorationLine: "none",
    cursor: { default: "pointer", ":disabled": "not-allowed" },
    // iOS delays a tap by 300ms looking for a double-tap unless told otherwise,
    // and paints a grey box over anything it decides is a link.
    touchAction: "manipulation",
    WebkitTapHighlightColor: "transparent",
    userSelect: "none",
    opacity: { default: 1, ":disabled": 0.55 },
  },
  /** A press that pushes in. Pair with `motion.press`. */
  sink: {
    transform: { default: "scale(1)", ":active:not(:disabled)": "scale(0.97)" },
  },
});

/**
 * Room for a finger. A text link sized by its own line — "Open calendar",
 * a footer link — is 20px tall, which a pointer hits and a thumb misses. Under
 * a touch screen it becomes a 44px row with the text centred in it; with a
 * mouse nothing about it changes.
 */
export const touch = stylex.create({
  target: {
    display: { default: null, [env.touch]: "inline-flex" },
    alignItems: { default: null, [env.touch]: "center" },
    minHeight: { default: null, [env.touch]: 44 },
  },
});

/** Kept so a component can reach the raw ramp when a semantic name is wrong. */
export const palette = { neutral, accent, shadows } as const;
