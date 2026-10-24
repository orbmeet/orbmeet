import * as stylex from "@stylexjs/stylex";
import type { StyleXStyles } from "@stylexjs/stylex";

import { decor } from "../tokens/colors.stylex";

const styles = stylex.create({
  sphere: {
    display: "block",
    flexShrink: 0,
    borderRadius: "50%",
    backgroundImage: `radial-gradient(circle at 32% 28%, ${decor.orbHighlight} 0%, ${decor.orbLit} 22%, ${decor.orbBody} 56%, ${decor.orbShade} 100%)`,
  },
  size: (px: number) => ({ width: px, height: px }),
  /** A soft halo, for the one orb on a page that is meant to be looked at. */
  glow: {
    boxShadow: `0 0 0 10px color-mix(in oklab, ${decor.orbBody} 14%, transparent), 0 0 60px color-mix(in oklab, ${decor.orbBody} 55%, transparent)`,
  },
});

interface OrbSphereProps {
  /** Diameter in px. */
  size?: number;
  glow?: boolean;
  sx?: StyleXStyles;
}

/**
 * The orb as an object: a lit violet sphere. Decorative — it never carries
 * meaning a reader would miss — so it is hidden from assistive technology.
 * Where the orb stands for Orb the assistant, the words beside it say so.
 */
export function OrbSphere({ size = 20, glow = false, sx }: OrbSphereProps) {
  return <span aria-hidden="true" {...stylex.props(styles.sphere, styles.size(size), glow && styles.glow, sx)} />;
}
