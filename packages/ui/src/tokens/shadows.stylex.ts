/**
 * Elevation — the single source of truth.
 *
 * Two axes, deliberately:
 *   `lift1/2/3` + `hover`   generic lift, for anything without a role below
 *   role tokens             surfaces that recur often enough to have a name,
 *                           so the same kind of thing lifts the same amount
 *                           everywhere it appears
 *
 * Page-local decorative glows (a hero card, a lit button) stay arbitrary —
 * they are art direction, not elevation, and tokenising a treatment that lives
 * on one route buys nothing. Anything that recurs across components is a role;
 * give it a name here instead.
 */
import * as stylex from "@stylexjs/stylex";

import { accent, ink, surface, warning } from "./colors.stylex";
import { inkWash, scrimBase } from "./wash.stylex";

export const shadows = stylex.defineVars({
  none: "none",

  lift1: `0 1px 3px ${inkWash.x04}, 0 1px 2px ${inkWash.x03}`,
  lift2: `0 8px 32px -4px ${inkWash.x06}, 0 2px 10px -1px ${inkWash.x03}, inset 0 1px 0 color-mix(in oklab, ${surface.raised} 80%, transparent)`,
  lift3: `0 20px 40px -8px ${inkWash.x10}, 0 8px 16px -4px ${inkWash.x06}, inset 0 1px 0 color-mix(in oklab, ${surface.raised} 90%, transparent)`,
  hover: `0 16px 40px -8px ${inkWash.x08}, 0 4px 12px -2px ${inkWash.x04}, inset 0 1px 0 color-mix(in oklab, ${surface.raised} 90%, transparent)`,

  /** A resting card in a grid. */
  card: `0 1px 2px ${inkWash.x04}, 0 8px 24px -12px ${inkWash.x12}`,
  /** The hover state of one. */
  cardHover: `0 2px 6px ${inkWash.x04}, 0 18px 40px -14px ${inkWash.x12}`,
  /** A hairline, for a card that is already sitting on white. */
  hairline: `0 1px 2px ${inkWash.x03}`,
  /** Dialogs and anything that has taken over the screen. */
  elevated: `0 20px 40px -8px ${inkWash.x10}, 0 8px 16px -4px ${inkWash.x06}`,
  /** Small labels riding directly on video — a hairline, not a lift. */
  chip: `0 1px 3px ${inkWash.x08}`,
  /** Meeting side panels (chat, participants, hand raise) floating over the stage. */
  float: `0 8px 32px -8px color-mix(in oklab, ${scrimBase.black} 15%, transparent)`,
  /** Detached overlay surfaces: menus, pickers, toolbar popovers. */
  popover: `0 12px 40px color-mix(in oklab, ${scrimBase.black} 15%, transparent)`,
  /** Transient notice strips, which sit close to their surface. */
  banner: `0 18px 40px -22px color-mix(in oklab, ${ink.shadow} 35%, transparent)`,
  /** Floating action pills over a dark or busy backdrop. */
  pill: `0 8px 24px color-mix(in oklab, ${ink.shadow} 22%, transparent)`,

  /** The primary button's own lift: a soft accent-coloured pool beneath it. */
  glowPrimary: `0 1px 2px ${inkWash.x06}, 0 6px 16px -8px color-mix(in oklab, ${accent.a600} 60%, transparent)`,
  glowPrimaryHover: `0 2px 4px ${inkWash.x06}, 0 10px 22px -8px color-mix(in oklab, ${accent.a600} 65%, transparent)`,
  glowAccent: `0 16px 40px -8px color-mix(in oklab, ${accent.a600} 28%, transparent)`,
  glowWarning: `0 16px 40px -8px color-mix(in oklab, ${warning.w600} 30%, transparent)`,
  aura: `0 0 40px -10px color-mix(in oklab, ${accent.a500} 16%, transparent)`,
});
