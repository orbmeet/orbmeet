import { BrandMark } from "@orbmeet/ui/react";
import { enter } from "@orbmeet/ui/styles/animations";
import { focus, motion } from "@orbmeet/ui/styles/atoms";
import { ink, surface } from "@orbmeet/ui/tokens/colors.stylex";
import { bp } from "@orbmeet/ui/tokens/media.stylex";
import { measure, space } from "@orbmeet/ui/tokens/space.stylex";
import { fonts, text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

const styles = stylex.create({
  root: {
    display: "flex",
    flexDirection: "column",
    minHeight: "100vh",
    backgroundColor: surface.canvas,
  },
  bar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.s4,
    paddingInline: { default: space.s4, [bp.sm]: space.s8 },
    paddingBlock: space.s5,
  },
  brand: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.s2_5,
    borderRadius: 8,
    color: ink.strong,
    textDecorationLine: "none",
    fontFamily: fonts.heading,
    fontSize: text.base,
    fontWeight: weight.semibold,
    letterSpacing: "-0.02em",
  },
  back: {
    display: "inline-flex",
    alignItems: "center",
    minHeight: 44,
    borderRadius: 8,
    fontSize: text.sm,
    color: ink.muted,
    textDecorationLine: "none",
  },
  main: {
    display: "flex",
    flexGrow: 1,
    alignItems: { default: "flex-start", [bp.sm]: "center" },
    justifyContent: "center",
    paddingInline: { default: space.s4, [bp.sm]: space.s8 },
    paddingTop: { default: space.s6, [bp.sm]: 0 },
    paddingBottom: space.s16,
  },
  column: { width: "100%", maxWidth: measure.form, display: "flex", flexDirection: "column", gap: space.s7 },
});

/**
 * Signing in, signing up and confirming an email share one quiet frame: the
 * mark, then the form, on the app's own ground in either theme. The mark
 * breathes — Orb is listening for you to arrive — and holds still under
 * reduced motion. No panel and no rotating lines: one thing on the screen,
 * the thing to do.
 */
export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div {...stylex.props(styles.root)}>
      <header {...stylex.props(styles.bar)}>
        <Link to="/" {...stylex.props(styles.brand, focus.ring)}>
          <BrandMark size={24} />
          Orb Meet
        </Link>
        <Link to="/" {...stylex.props(styles.back, motion.tint, focus.ring)}>
          Back to home
        </Link>
      </header>
      <main {...stylex.props(styles.main)}>
        <div {...stylex.props(styles.column, enter.fadeUp)}>
          <BrandMark size={40} state="listening" />
          <div>{children}</div>
        </div>
      </main>
    </div>
  );
}
