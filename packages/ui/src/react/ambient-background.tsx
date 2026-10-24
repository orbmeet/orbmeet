import * as stylex from "@stylexjs/stylex";

import { accent, neutral } from "../tokens/colors.stylex";

export type AmbientVariant = "home" | "spaces" | "history" | "settings";

const styles = stylex.create({
  root: {
    position: "fixed",
    inset: 0,
    // Behind everything, including the page background's own children.
    zIndex: -1,
    overflow: "hidden",
    pointerEvents: "none",
  },
  orb: {
    position: "absolute",
    borderRadius: "50%",
    filter: "blur(120px)",
  },
});

/**
 * Per-surface ambience.
 *
 * One quiet language for every surface: a barely-there blue wash, tiered by
 * how much visual energy a task-focused screen should carry. Home is
 * liveliest; History and Settings are quiet, so a retrospective log and a
 * forms page don't compete for attention the way the "front door" pages do.
 *
 * The Home hero carries its own glow, so ambience never competes with content.
 */
const orbs = stylex.create({
  home: {
    top: "8%",
    right: "12%",
    width: 480,
    height: 480,
    backgroundColor: accent.a100,
    opacity: 0.22,
  },
  spaces: {
    top: "8%",
    right: "8%",
    width: 440,
    height: 440,
    backgroundColor: accent.a100,
    opacity: 0.18,
  },
  history: {
    top: "12%",
    left: "8%",
    width: 420,
    height: 420,
    backgroundColor: accent.a50,
    opacity: 0.3,
  },
  settings: {
    top: "10%",
    right: "10%",
    width: 400,
    height: 400,
    backgroundColor: neutral.n100,
    opacity: 0.35,
  },
});

export function AmbientBackground({ variant }: { variant: AmbientVariant }) {
  return (
    <div aria-hidden {...stylex.props(styles.root)}>
      <div {...stylex.props(styles.orb, orbs[variant])} />
    </div>
  );
}
