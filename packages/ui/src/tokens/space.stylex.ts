/**
 * The spacing scale: a 4px grid, named by step.
 *
 * `defineConsts` so the value inlines — spacing is the single most-used token
 * in the app and there is nothing to gain from resolving 2,000 elements'
 * padding through a custom property at runtime. Nothing themes its gutters.
 *
 * Steps are the familiar 4px ramp, so `s4` is 1rem exactly as `p-4` was. Use
 * the named ends (`gutter`, `section`) where a value means something beyond
 * its size.
 */
import * as stylex from "@stylexjs/stylex";

export const space = stylex.defineConsts({
  s0: "0px",
  sPx: "1px",
  s0_5: "0.125rem",
  s1: "0.25rem",
  s1_5: "0.375rem",
  s2: "0.5rem",
  s2_5: "0.625rem",
  s3: "0.75rem",
  s3_5: "0.875rem",
  s4: "1rem",
  s5: "1.25rem",
  s6: "1.5rem",
  s7: "1.75rem",
  s8: "2rem",
  s9: "2.25rem",
  s10: "2.5rem",
  s12: "3rem",
  s14: "3.5rem",
  s16: "4rem",
  s20: "5rem",
  s24: "6rem",
  s32: "8rem",

  /** The horizontal breathing room at a page edge on a phone. */
  gutter: "1rem",
  /** The same, on a desktop shell. */
  gutterWide: "1.5rem",
  /** Vertical rhythm between two sections of a page. */
  section: "4rem",
});

/** Content measures. The widths a column of prose or a shell is allowed to be. */
export const measure = stylex.defineConsts({
  prose: "65ch",
  form: "28rem",
  panel: "36rem",
  page: "72rem",
  wide: "80rem",
});
