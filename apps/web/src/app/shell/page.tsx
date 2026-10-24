import { AmbientBackground } from "@orbmeet/ui/react";
import type { AmbientVariant } from "@orbmeet/ui/react";
import { measure, space } from "@orbmeet/ui/tokens/space.stylex";
import * as stylex from "@stylexjs/stylex";
import type { StyleXStyles } from "@stylexjs/stylex";
import type { ReactNode } from "react";

const styles = stylex.create({
  /**
   * No inline padding: the authed shell's `<main>` owns the page gutters, so a
   * page adding its own doubled them on a phone (32px against the header's 16).
   */
  root: {
    position: "relative",
    marginInline: "auto",
    width: "100%",
  },
  narrow: { maxWidth: "48rem" },
  default: { maxWidth: "64rem" },
  wide: { maxWidth: measure.page },

  padDefault: { paddingBlock: space.s8 },
  padTight: { paddingBlock: space.s2 },
  padNone: {},
});

const widths = { narrow: styles.narrow, default: styles.default, wide: styles.wide } as const;
const pads = { default: styles.padDefault, tight: styles.padTight, none: styles.padNone } as const;

interface PageProps {
  /** Max content width. `narrow` for focused single-column pages; `wide` fits the dashboard. */
  width?: keyof typeof widths;
  /** Which ambient palette to render. Omit to render none. */
  ambient?: AmbientVariant;
  /** Vertical padding — the dashboard wants more breathing room than a detail view. */
  py?: keyof typeof pads;
  sx?: StyleXStyles;
  children: ReactNode;
}

/**
 * App-shell page container. Encapsulates the centred-column + ambient
 * background contract every authenticated route shares, so max-width, padding
 * and the ambient layer cannot drift per route again.
 */
export function Page({ width = "default", ambient, py = "default", sx, children }: PageProps) {
  return (
    <div {...stylex.props(styles.root, widths[width], pads[py], sx)}>
      {ambient ? <AmbientBackground variant={ambient} /> : null}
      {children}
    </div>
  );
}
