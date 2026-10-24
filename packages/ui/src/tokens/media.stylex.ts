/**
 * Breakpoints and environment queries, as StyleX media constants.
 *
 * Every responsive decision in the app spells one of these names. Writing the
 * query inline is how two components end up disagreeing about where "phone"
 * ends by 1px.
 */
import * as stylex from "@stylexjs/stylex";

/**
 * Min-width breakpoints — the default direction. Design for the phone, then
 * add at each step up.
 */
export const bp = stylex.defineConsts({
  sm: "@media (min-width: 640px)",
  md: "@media (min-width: 768px)",
  lg: "@media (min-width: 1024px)",
  xl: "@media (min-width: 1280px)",
  xl2: "@media (min-width: 1536px)",
});

/** Capability and preference queries. */
export const env = stylex.defineConsts({
  /** A real pointer, where hover states are meaningful. */
  hoverable: "@media (hover: hover) and (pointer: fine)",
  reducedMotion: "@media (prefers-reduced-motion: reduce)",
  /**
   * The GPU-cost guard. Heavy backdrop blur is capped here — see
   * `effects.glassHeavy`. Phones and touch laptops both qualify.
   */
  cheapPaint: "@media (pointer: coarse), (max-width: 768px)",
  /** A finger is doing the pointing, where targets have to be big enough to hit without aiming. */
  touch: "@media (pointer: coarse)",
  /** Landscape on a short viewport — a phone held sideways in a meeting. */
  shortLandscape: "@media (orientation: landscape) and (max-height: 500px)",
});

/**
 * The device's unsafe edges — notch, Dynamic Island, home indicator, rounded
 * corners — named once.
 *
 * `viewport-fit=cover` (set in `__root.tsx`) is what makes these non-zero on a
 * notched device. Everywhere else they resolve to `0px` through the `env()`
 * fallback, so they are safe to apply unconditionally: there is no `@supports`
 * gate and no phone-only variant to remember.
 */
export const safeArea = stylex.defineConsts({
  top: "env(safe-area-inset-top, 0px)",
  right: "env(safe-area-inset-right, 0px)",
  bottom: "env(safe-area-inset-bottom, 0px)",
  left: "env(safe-area-inset-left, 0px)",
});
