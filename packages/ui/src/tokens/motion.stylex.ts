/**
 * Easing curves and durations.
 *
 * `defineConsts`, not `defineVars`: these are inlined at compile time, so a
 * transition costs no custom-property indirection, and a duration const can be
 * interpolated into a `transition` shorthand, which a themeable var cannot.
 */
import * as stylex from "@stylexjs/stylex";

export const easing = stylex.defineConsts({
  /** Overshoots. For something arriving that should feel physical. */
  bounce: "cubic-bezier(0.34, 1.56, 0.64, 1)",
  /** Decelerates hard. The default for anything entering. */
  gentle: "cubic-bezier(0.16, 1, 0.3, 1)",
  /** Symmetric. The default for a state change in place. */
  stiff: "cubic-bezier(0.4, 0, 0.2, 1)",
  linear: "linear",
});

export const duration = stylex.defineConsts({
  /** A hover tint, a focus ring. */
  instant: "120ms",
  /** The default: a button pressing, a chip appearing. */
  fast: "180ms",
  /** A panel sliding, a card lifting. */
  base: "240ms",
  /** A dialog, a route transition. */
  slow: "360ms",
});
