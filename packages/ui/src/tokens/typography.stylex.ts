/**
 * Type tokens.
 *
 * Families and the fluid display sizes are `defineVars` (a theme may want to
 * swap the display face); the fixed step scale is `defineConsts` because a
 * font size that never changes at runtime has no reason to cost a custom
 * property lookup on every element that uses it.
 */
import * as stylex from "@stylexjs/stylex";

/**
 * One family, served with the app so every device sets the room the same way:
 * Geist for the interface and for headings, which get their voice from weight
 * and tight tracking rather than from a second face. Code and clocks are
 * Geist Mono.
 *
 * `heading` stays its own var so a theme can still swap the display face
 * without touching every title.
 */
const GEIST = '"Geist", ui-sans-serif, system-ui, sans-serif';

export const fonts = stylex.defineVars({
  sans: GEIST,
  heading: GEIST,
  /**
   * Geist Mono, served with the app like the interface face: codes, clocks and counts —
   * figures that must not shift as they change — and code itself.
   */
  mono: '"Geist Mono", ui-monospace, monospace',
});

/**
 * Fluid headline sizes. Vars rather than consts so a dense layout can clamp
 * them for a subtree without every call site opting in.
 */
export const display = stylex.defineVars({
  hero: "clamp(3rem, 5vw + 1rem, 5.5rem)",
  h1: "clamp(2.25rem, 3.5vw + 0.5rem, 3.75rem)",
  h2: "clamp(1.5rem, 2vw + 0.5rem, 2.25rem)",
  h3: "clamp(1.125rem, 1.2vw + 0.1rem, 1.5rem)",
});

/** The fixed step scale. */
export const text = stylex.defineConsts({
  xs4: "0.5rem",
  xs3: "0.5625rem",
  xs2: "0.625rem",
  xs: "0.75rem",
  /** Labels on the room's controls: between caption and body. */
  control: "0.8125rem",
  sm: "0.875rem",
  base: "1rem",
  lg: "1.125rem",
  xl: "1.25rem",
  xl2: "1.5rem",
  xl3: "1.875rem",
  xl4: "2.25rem",
  xl5: "3rem",
});

/** Line heights paired with the step scale above. */
export const leading = stylex.defineConsts({
  xs4: "0.75rem",
  xs3: "0.875rem",
  xs2: "1rem",
  xs: "1rem",
  control: "1.125rem",
  sm: "1.25rem",
  base: "1.5rem",
  lg: "1.75rem",
  xl: "1.75rem",
  xl2: "2rem",
  xl3: "2.25rem",
  xl4: "2.5rem",
  xl5: "1",
  /** For multi-line prose that needs air. */
  relaxed: "1.625",
  /** For headings that wrap. */
  tight: "1.15",
});

/** Tracking. Only the values the design actually uses. */
export const tracking = stylex.defineConsts({
  tighter: "-0.03em",
  tight: "-0.015em",
  normal: "0",
  wide: "0.02em",
  wider: "0.06em",
  widest: "0.12em",
});

export const weight = stylex.defineConsts({
  normal: "400",
  medium: "500",
  semibold: "600",
  bold: "700",
  extrabold: "800",
});
