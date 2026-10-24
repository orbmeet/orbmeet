import { BrandMark } from "@orbmeet/ui/react";
import { focus, motion } from "@orbmeet/ui/styles/atoms";
import { border, ink, surface } from "@orbmeet/ui/tokens/colors.stylex";
import { zIndex } from "@orbmeet/ui/tokens/layers.stylex";
import { bp, env } from "@orbmeet/ui/tokens/media.stylex";
import { measure, space } from "@orbmeet/ui/tokens/space.stylex";
import { fonts, text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import { Link } from "@tanstack/react-router";
import * as stylex from "@stylexjs/stylex";
import { ArrowLeft } from "lucide-react";

import { SkipLink } from "./skip-link";

const styles = stylex.create({
  /**
   * A flat bar on the page's own ground, like the one over sign-in: the mark
   * and name, and the way back. No floating glass card — the content is the
   * thing on the page.
   */
  dock: {
    paddingInline: { default: space.s4, [bp.sm]: space.s8 },
    backgroundColor: surface.canvas,
  },
  /** Document pages scroll their nav away with the prose. */
  dockDocument: { position: "relative", zIndex: zIndex.popover },
  /** Marketing pages keep it pinned, with a hairline once it sits over content. */
  dockMarketing: {
    position: "sticky",
    top: 0,
    zIndex: zIndex.popover,
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: border.subtle,
  },
  bar: {
    marginInline: "auto",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.s4,
    paddingBlock: space.s5,
  },
  // The bar tracks the width of the content column under it.
  barDocument: { maxWidth: "64rem" },
  barMarketing: { maxWidth: measure.page },
  brand: {
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    gap: space.s2_5,
    minHeight: 44,
    borderRadius: 8,
    textDecorationLine: "none",
  },
  name: {
    fontFamily: fonts.heading,
    fontSize: text.base,
    fontWeight: weight.semibold,
    letterSpacing: "-0.02em",
    color: ink.strong,
  },
  back: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.s1_5,
    minHeight: 44,
    borderRadius: 8,
    fontSize: text.sm,
    color: { default: ink.muted, [env.hoverable]: { default: ink.muted, ":hover": ink.strong } },
    textDecorationLine: "none",
  },
});

const docks = { document: styles.dockDocument, marketing: styles.dockMarketing } as const;
const bars = { document: styles.barDocument, marketing: styles.barMarketing } as const;

interface PublicNavProps {
  /**
   * `document` for the legal pages — a static bar over a narrow prose column.
   * `marketing` for the long scrolling pages, where the nav stays pinned.
   */
  variant?: keyof typeof docks;
}

/**
 * The brand-and-back nav shared by every unauthenticated public page.
 *
 * This was copy-pasted across `/terms`, `/privacy`, `/refund` and `/pricing`,
 * and the four copies had already drifted (a raw `zIndex: 50` in one, a
 * missing `aria-hidden` on the arrow in another). Owning it here keeps
 * every public page's top edge the same.
 */
export function PublicNav({ variant = "document" }: PublicNavProps) {
  return (
    <header {...stylex.props(styles.dock, docks[variant])}>
      {/* First focusable thing in the document on every page that has a nav. */}
      <SkipLink />
      <div {...stylex.props(styles.bar, bars[variant])}>
        <Link to="/" {...stylex.props(styles.brand, focus.ring)}>
          {/* The wordmark beside it is the link's accessible name; an alt here
              would make the whole thing announce as "Orb Meet Orb Meet". */}
          <BrandMark size={24} />
          <span {...stylex.props(styles.name)}>Orb Meet</span>
        </Link>
        <Link to="/" {...stylex.props(styles.back, motion.tint, focus.ring)}>
          <ArrowLeft size={16} aria-hidden="true" />
          Back to home
        </Link>
      </div>
    </header>
  );
}
