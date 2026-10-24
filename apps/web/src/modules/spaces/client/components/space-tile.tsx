import { hashStringToIndex } from "@orbmeet/ui/gradient-hash";
import { identity, neutral } from "@orbmeet/ui/tokens/colors.stylex";
import { fonts, weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";
import type { StyleXStyles } from "@stylexjs/stylex";

/**
 * A Space's mark: its initial on a soft square, in the colour its name hashes
 * to. The same pastel-and-ink pairs as people's avatars, so a Space sits among
 * faces without shouting over them, and the same name keeps the same colour
 * in the rail, a row, and its own header.
 */
const tones = stylex.create({
  t0: { backgroundColor: identity.surface1, color: identity.ink1 },
  t1: { backgroundColor: identity.surface2, color: identity.ink2 },
  t2: { backgroundColor: identity.surface3, color: identity.ink3 },
  t3: { backgroundColor: identity.surface4, color: identity.ink4 },
  t4: { backgroundColor: identity.surface5, color: identity.ink5 },
  t5: { backgroundColor: identity.surface6, color: identity.ink6 },
  t6: { backgroundColor: identity.surface7, color: identity.ink7 },
  t7: { backgroundColor: identity.surface8, color: identity.ink8 },
});

const toneByIndex = [tones.t0, tones.t1, tones.t2, tones.t3, tones.t4, tones.t5, tones.t6, tones.t7] as const;

const styles = stylex.create({
  root: {
    display: "inline-grid",
    flexShrink: 0,
    placeItems: "center",
    fontWeight: weight.semibold,
    lineHeight: 1,
    userSelect: "none",
    // A hairline in the tile's own ink: the pastels are light enough to fade
    // into a grey rail without one.
    boxShadow: "inset 0 0 0 1px color-mix(in oklab, currentColor 16%, transparent)",
  },
  xs: { width: 18, height: 18, borderRadius: 5, fontSize: "0.625rem" },
  sm: { width: 20, height: 20, borderRadius: 6, fontSize: "0.6875rem" },
  md: { width: 36, height: 36, borderRadius: 10, fontSize: "0.9375rem" },
  lg: { width: 64, height: 64, borderRadius: 18, fontSize: "1.875rem", fontFamily: fonts.heading },
  /** Personal has no name to hash: a quiet neutral square. */
  personal: { backgroundColor: neutral.n150, color: neutral.n700 },
});

const sizes = { xs: styles.xs, sm: styles.sm, md: styles.md, lg: styles.lg } as const;

interface SpaceTileProps {
  name: string;
  size?: keyof typeof sizes;
  /** The viewer's own Personal space, which has no colour of its own. */
  personal?: boolean;
  sx?: StyleXStyles;
}

export function SpaceTile({ name, size = "sm", personal, sx }: SpaceTileProps) {
  const initial = Array.from(name.trim())[0]?.toUpperCase() ?? "·";
  return (
    <span
      aria-hidden="true"
      {...stylex.props(
        styles.root,
        sizes[size],
        personal ? styles.personal : toneByIndex[hashStringToIndex(name, toneByIndex.length)],
        sx,
      )}
    >
      {initial}
    </span>
  );
}
