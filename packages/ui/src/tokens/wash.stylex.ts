/**
 * Translucency — the layer the migration didn't have.
 *
 * `colors.stylex.ts` stops at opaque colour. Every translucent surface in the
 * app was therefore a hand-typed `rgba()`: the rgb triple of a token, with an
 * alpha stapled on, because `rgba()` cannot take a custom property as its
 * colour. 461 of them across 80 files.
 *
 * Re-tune `accent.a500` in the palette and hand-copied translucent sites kept
 * the old blue, with no error and no failing test. Deriving the defaults here
 * keeps source-level palette changes (and themes applied at the root) in sync.
 * A theme applied only to a descendant must still override the derived ramp as
 * well as its base: custom properties inherit their computed value from the
 * element where they are declared.
 *
 * `color-mix()` is the fix, and it is used in two shapes:
 *
 *  1. **Named, here.** A wash that recurs across components and *means*
 *     something gets a name in this file — the scrim ramp behind a dialog, the
 *     glass ramp a meeting panel is built from. Those are roles, and roles
 *     belong in tokens.
 *
 *  2. **Inline, at the call site.** The long tail — `ink.strong` at 6% for one
 *     card's hairline — stays written where it is used, as
 *     `color-mix(in oklab, ${ink.strong} 6%, transparent)`. Naming a
 *     one-off `inkWash06` moves the magic number without removing it, and
 *     StyleX folds identical declarations into one atomic class anyway, so the
 *     inline form costs nothing a token would have saved.
 *
 * The mixing space is `oklab` throughout. Mixing toward `transparent` in sRGB
 * darkens the midpoints of a fade; oklab holds the hue steady, which is visible
 * on the long gradients over video.
 */
import * as stylex from "@stylexjs/stylex";

import { ink, surface } from "./colors.stylex";

/**
 * Black veils — the dark side of the app.
 *
 * Video gradients, dialog backdrops, the hairline ring around a control on a
 * busy ground. These mix from pure black rather than `neutral.n950`: a scrim's
 * job is to remove light, and n950 (`#020617`) carries a blue cast that tints
 * whatever it covers.
 *
 * The base is a real token so the ramp has one source colour. Root-level themes
 * may re-point it once; subtree themes must redeclare the ramp too because the
 * derived variables are computed at the root before they inherit.
 */
export const scrimBase = stylex.defineVars({
  /**
   * Its own group so the ramp below can reference it. A `defineVars` group
   * cannot derive from itself — TypeScript cannot type the circularity — so the
   * base a theme repoints lives one level up.
   */
  black: "#000000",
});

export const scrim = stylex.defineVars({
  /** A hairline ring — barely there, but enough to separate. */
  hairline: () => `color-mix(in oklab, ${scrimBase.black} 5%, transparent)`,
  /** The default edge on a control sitting over video. */
  edge: () => `color-mix(in oklab, ${scrimBase.black} 10%, transparent)`,
  /** A resting shadow's colour, and the lightest usable veil. */
  soft: () => `color-mix(in oklab, ${scrimBase.black} 25%, transparent)`,
  /** Legibility wash under a caption or a name plate. */
  wash: () => `color-mix(in oklab, ${scrimBase.black} 40%, transparent)`,
  /** A dialog backdrop over the app. */
  backdrop: () => `color-mix(in oklab, ${scrimBase.black} 50%, transparent)`,
  /** The bottom of a video gradient, where text has to survive. */
  strong: () => `color-mix(in oklab, ${scrimBase.black} 65%, transparent)`,
  /** Nearly opaque — a full takeover. */
  heavy: () => `color-mix(in oklab, ${scrimBase.black} 75%, transparent)`,
});

/**
 * Luminous glass — the light side.
 *
 * The meeting room's panels and every chip that rides on video. Mixed from
 * `surface.raised` rather than a literal white so a re-themed surface carries
 * its panels with it.
 */
export const glass = stylex.defineVars({
  /** A whisper of light over a busy ground — inner top edges, faint fills. */
  veil: () => `color-mix(in oklab, ${surface.raised} 10%, transparent)`,
  /** A chip on video that still shows the video through it. */
  sheer: () => `color-mix(in oklab, ${surface.raised} 60%, transparent)`,
  /** The default panel fill. */
  panel: () => `color-mix(in oklab, ${surface.raised} 80%, transparent)`,
  /** A panel that has to hold body copy. */
  solid: () => `color-mix(in oklab, ${surface.raised} 90%, transparent)`,
  /** A modal over the room — glass in name only. */
  opaque: () => `color-mix(in oklab, ${surface.raised} 95%, transparent)`,
});

/**
 * Ink washes — the greys that aren't greys.
 *
 * Every soft lift and hairline in the app is `ink.shadow` at a low alpha —
 * the palette's own ink in light, which keeps a shadow reading as *this*
 * palette's shadow rather than a generic black blur, and black in dark, where
 * a light ink would glow. The steps here are the ones `shadows.stylex.ts` and the
 * card surfaces reach for; anything outside them stays inline.
 */
export const inkWash = stylex.defineVars({
  /** The lightest lift — a card already sitting on white. */
  x03: () => `color-mix(in oklab, ${ink.shadow} 3%, transparent)`,
  x04: () => `color-mix(in oklab, ${ink.shadow} 4%, transparent)`,
  x06: () => `color-mix(in oklab, ${ink.shadow} 6%, transparent)`,
  x08: () => `color-mix(in oklab, ${ink.shadow} 8%, transparent)`,
  x10: () => `color-mix(in oklab, ${ink.shadow} 10%, transparent)`,
  x12: () => `color-mix(in oklab, ${ink.shadow} 12%, transparent)`,
});
