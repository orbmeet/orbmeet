import { focus, motion } from "@orbmeet/ui/styles/atoms";
import { border, ink, surface } from "@orbmeet/ui/tokens/colors.stylex";
import { bp, env } from "@orbmeet/ui/tokens/media.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { measure, space } from "@orbmeet/ui/tokens/space.stylex";
import { text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import { Link } from "@tanstack/react-router";
import * as stylex from "@stylexjs/stylex";

/**
 * Where the footer links point. Pricing and Status are also in the landing
 * chrome; Terms, Privacy and Refunds live here only, which is why every public
 * page needs this footer rather than just the long one.
 */
const FOOTER_LINKS = [
  { to: "/pricing", label: "Pricing" },
  { to: "/status", label: "Status" },
  { to: "/terms", label: "Terms" },
  { to: "/privacy", label: "Privacy" },
  { to: "/refund", label: "Refunds" },
] as const;

const styles = stylex.create({
  footer: {
    marginTop: "auto",
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: border.subtle,
    backgroundColor: surface.raised,
    paddingInline: { default: space.s5, [bp.sm]: space.s8 },
    paddingBlock: space.s8,
  },
  row: {
    marginInline: "auto",
    display: "flex",
    maxWidth: measure.page,
    flexDirection: { default: "column", [bp.sm]: "row" },
    alignItems: "center",
    justifyContent: { default: "flex-start", [bp.sm]: "space-between" },
    gap: space.s5,
  },
  blurb: { fontSize: text.sm, color: ink.muted, textAlign: "center" },
  links: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "center",
    // Column gap carries the visual rhythm; the links pad themselves to a
    // 24px hit target, so the gap is measured from the padded edge.
    columnGap: space.s3,
    rowGap: space.s1,
  },
  /**
   * Padded to the WCAG 2.2 minimum target size. These were 36×18 — the
   * smallest hit targets in the product, in the corner of the page where a
   * thumb is least accurate.
   */
  link: {
    display: "inline-flex",
    minHeight: 24,
    alignItems: "center",
    borderRadius: radii.field,
    paddingInline: space.s2,
    fontSize: text.xs,
    fontWeight: weight.medium,
    color: { default: ink.muted, [env.hoverable]: { default: ink.muted, ":hover": ink.strong } },
    textDecorationLine: "none",
  },
});

/**
 * The footer shared by every public page.
 *
 * `/pricing`, `/status` and the three legal pages end in it, so the pricing
 * table links straight to the refund policy it depends on. It lives beside
 * `PublicNav` because the two are the same decision: public chrome is stated
 * once.
 */
export function PublicFooter() {
  return (
    <footer {...stylex.props(styles.footer)}>
      <div {...stylex.props(styles.row)}>
        <span {...stylex.props(styles.blurb)}>
          Orb Meet · Open-source visual meeting workspace · MIT licensed
        </span>
        <nav aria-label="Footer navigation" {...stylex.props(styles.links)}>
          {FOOTER_LINKS.map(({ to, label }) => (
            <Link key={to} to={to} {...stylex.props(styles.link, focus.ring, motion.tint)}>
              {label}
            </Link>
          ))}
        </nav>
      </div>
    </footer>
  );
}
