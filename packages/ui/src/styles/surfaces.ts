/**
 * Surfaces — the raised, glassy and lit panels the app is built from.
 *
 * The stylesheet this replaces had grown five near-identical definitions of
 * "a white card" (`.surface`, `.bento-card`, `.liquid-glass`,
 * `.liquid-glass-glow`, `.liquid-glass-soft`) plus a `--danger` and an
 * `--elevated` modifier on two of them. They are one thing here, composed:
 * `surfaces.card` is the surface, and `surfaces.interactive`,
 * `surfaces.elevated`, `surfaces.danger` are things you add to it.
 */
import * as stylex from "@stylexjs/stylex";

import { border, danger, decor, ink, neutral, surface } from "../tokens/colors.stylex";
import { duration, easing } from "../tokens/motion.stylex";
import { env } from "../tokens/media.stylex";
import { radii } from "../tokens/radii.stylex";
import { shadows } from "../tokens/shadows.stylex";
import { glass, inkWash, scrim } from "../tokens/wash.stylex";

/**
 * Backdrop blur, capped on devices that pay for it.
 *
 * The old stylesheet capped blur with an `!important` attribute-substring
 * selector, which matched every `backdrop-blur-*` utility and promoted the
 * ones asking for *less* — a full-screen 1px scrim became a viewport-sized 6px
 * backdrop-filter layer over decoding video, courtesy of a performance guard.
 * Here each step names its own coarse-pointer value, so a cap can only ever
 * lower a blur, never raise one.
 */
export const blur = stylex.create({
  sm: { backdropFilter: "blur(4px)" },
  md: { backdropFilter: "blur(8px)" },
  xl: { backdropFilter: { default: "blur(24px)", [env.cheapPaint]: "blur(6px)" } },
});

export const surfaces = stylex.create({
  /**
   * The base raised card. White, hairline, panel radius, a whisper of lift.
   *
   * `overflow: hidden` is part of the definition: a card is a clipping box, so
   * a full-bleed image or a sticky header inside one follows its corners
   * without every instance remembering to say so.
   */
  card: {
    backgroundColor: surface.raised,
    borderWidth: 1,
    borderStyle: "solid",
    // Floats on the canvas: a soft shadow carries the edge, and the border
    // stays (transparent) so a variant like `danger` can still colour it.
    borderColor: "transparent",
    borderRadius: radii.panel,
    boxShadow: shadows.card,
    overflow: "hidden",
    transitionProperty: "background-color, border-color, box-shadow",
    transitionDuration: { default: duration.base, [env.reducedMotion]: "0s" },
    transitionTimingFunction: easing.stiff,
  },

  /** A destructive zone — "delete this workspace". Add to `card`. */
  danger: {
    borderColor: danger.d200,
  },

  /** The same panel, more opaque and more lifted — a modal over the room. */
  glassSolid: {
    backgroundColor: glass.opaque,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: `color-mix(in oklab, ${border.base} 80%, transparent)`,
    borderRadius: radii.panel,
    boxShadow:
      `0 20px 40px -12px ${inkWash.x08}, 0 8px 16px -6px ${inkWash.x04}`,
    backdropFilter: { default: "blur(20px)", [env.cheapPaint]: "blur(6px)" },
  },

  /** Lighter and softer — loading states, transient shells. */
  glassSoft: {
    backgroundImage:
      `linear-gradient(135deg, color-mix(in oklab, ${surface.raised} 85%, transparent), color-mix(in oklab, ${decor.glassCooler} 75%, transparent))`,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: `color-mix(in oklab, ${border.base} 60%, transparent)`,
    borderRadius: radii.panel,
    boxShadow: `0 16px 40px -12px ${inkWash.x12}`,
    backdropFilter: { default: "blur(16px)", [env.cheapPaint]: "blur(6px)" },
  },

  /** Dark glass, for an overlay that sits on top of light content. */
  glassDark: {
    backgroundImage:
      `linear-gradient(135deg, color-mix(in oklab, ${surface.inverse} 88%, transparent), color-mix(in oklab, ${neutral.n800} 92%, transparent))`,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: `color-mix(in oklab, ${neutral.n700} 50%, transparent)`,
    borderRadius: radii.panel,
    boxShadow: `0 24px 48px -8px ${scrim.soft}`,
    backdropFilter: { default: "blur(24px)", [env.cheapPaint]: "blur(6px)" },
    color: ink.onDark,
  },
});

/**
 * Soft light behind a surface. Purely decorative — always paired with
 * `layout.decorative`.
 */
export const glow = stylex.create({
  /** A soft, tinted orb. Size and position are the caller's. */
  orb: (color: string, blurPx: number) => ({
    position: "absolute",
    pointerEvents: "none",
    borderRadius: "50%",
    backgroundImage: `radial-gradient(circle, ${color}, transparent 70%)`,
    filter: `blur(${blurPx}px)`,
  }),
});
