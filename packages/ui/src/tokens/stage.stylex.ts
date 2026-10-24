/**
 * Meeting stage geometry.
 *
 * `MeetingShell` publishes the final stage and board edges from the furniture
 * that is actually mounted. The safe-area expression is written on that same
 * shell element, so custom-property substitution happens in the scope where
 * the runtime values exist.
 *
 * Surfaces inside the room position against these, never against `env()`
 * directly. That indirection is the point: a tile label, the whiteboard camera
 * and the dock can no longer disagree about where the bottom of the
 * screen is.
 *
 * Unlike every other token group here, four members are *written* at runtime —
 * see `stageChrome()` in `../styles/stage.ts`. The defaults are the "no
 * furniture mounted" case, so a surface using them outside a meeting shell
 * still resolves to the plain safe-area inset instead of dropping the
 * declaration.
 */
import * as stylex from "@stylexjs/stylex";

/** The rect the stage may draw in: safe area plus mounted chrome. */
export const stage = stylex.defineVars({
  top: "env(safe-area-inset-top, 0px)",
  right: "env(safe-area-inset-right, 0px)",
  bottom: "env(safe-area-inset-bottom, 0px)",
  left: "env(safe-area-inset-left, 0px)",
  /**
   * Width reserved on the right for a docked side panel (chat, participants,
   * hand raises, search), including its gutters. Zero when none is open.
   *
   * Panels do not float over the board on `z-index`, where opening chat would
   * cover whatever is behind it. Reserving the width means the gallery reflows
   * into the space that is left, the way the rail already does.
   */
  panel: "0px",
});

/**
 * The board: the stage minus any docked rail.
 *
 * Floating chrome that should look centred — the control dock, access
 * requests — centres in here, never in the window. Centred on the
 * window with a 240px rail mounted, the dock sits 120px left of the space
 * people are actually looking at, and it slides sideways whenever the rail
 * appears.
 */
export const board = stylex.defineVars({
  right: "env(safe-area-inset-right, 0px)",
  left: "env(safe-area-inset-left, 0px)",
});
