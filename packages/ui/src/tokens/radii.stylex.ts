/**
 * Radius scale, named by role rather than by measurement.
 *
 * `radii.control` says what the element is; `12px` says what it measured on
 * the day it was written, and only the first one moves when the scale is
 * retuned. Never inline a raw pixel radius.
 */
import * as stylex from "@stylexjs/stylex";

export const radii = stylex.defineVars({
  /** Inputs, selects, small chips. */
  field: "0.75rem",
  /** Buttons, icon buttons, toggles. */
  control: "0.875rem",
  /** Cards, dialogs, panels. */
  card: "1.25rem",
  /** Large bento / hero surfaces. */
  panel: "1.5rem",
  /** Badges, status pills, avatars. */
  pill: "9999px",
});
