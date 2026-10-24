/**
 * Meeting stage geometry, as styles.
 *
 * `MeetingShell` calls `stageChrome()` with the furniture it actually mounted;
 * everything inside the room positions against the `stage.*` / `board.*`
 * namespaces below, which compose that with the device safe area.
 *
 * See `../tokens/stage.stylex.ts` for what each variable means and why the
 * rail width is deliberately kept out of the stage rect.
 */
import * as stylex from "@stylexjs/stylex";

import { board, stage } from "../tokens/stage.stylex";

/**
 * Published by the shell. Values are CSS lengths, not numbers, because the
 * rail width arrives as a string from the component that owns the rail.
 */
export const stageChrome = stylex.create({
  publish: (top: string, bottom: string, right: string, panel: string) => ({
    [stage.top]: `calc(env(safe-area-inset-top, 0px) + ${top})`,
    [stage.bottom]: `calc(env(safe-area-inset-bottom, 0px) + ${bottom})`,
    [stage.panel]: panel,
    [board.right]: `calc(env(safe-area-inset-right, 0px) + ${right})`,
  }),
});

/** Positioning against the stage rect. */
export const inStage = stylex.create({
  /** Fill the rect exactly, minus any docked side panel. */
  fill: {
    position: "absolute",
    top: stage.top,
    right: `calc(${stage.right} + ${stage.panel})`,
    bottom: stage.bottom,
    left: stage.left,
  },
  /**
   * Fill the whole window, minus any docked side panel.
   *
   * The gallery is deliberately full-bleed vertically — it runs under the
   * header and dock — but it must still stop at a panel rather than be covered
   * by one.
   */
  fillBesidePanel: {
    position: "absolute",
    top: 0,
    right: stage.panel,
    bottom: 0,
    left: 0,
  },
  /** Sit on the rect's top edge, `gap` above it. */
  top: (gap: string) => ({ top: `calc(${stage.top} + ${gap})` }),
});

/**
 * Positioning against the *board* — the stage minus any docked rail.
 *
 * Floating chrome that should look centred belongs here, not in the window.
 * With a 240px rail mounted, window-centred chrome sits 120px left of the
 * space people are actually looking at, and it slides sideways whenever the
 * rail appears or disappears.
 */
export const onBoard = stylex.create({
  spanX: {
    right: `calc(${board.right} + ${stage.panel})`,
    left: board.left,
  },
});

/*
 * There is no `onBoard.right` any more.
 *
 * The four side panels were its only callers, and they dock against the window
 * edge now so that the width they reserve (`stage.panel`) is measured from the
 * same edge they occupy. Anchoring them inside the rail instead put the
 * reservation and the panel on opposite sides of it.
 */
