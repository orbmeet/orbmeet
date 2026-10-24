import { motion, safe } from "@orbmeet/ui/styles/atoms";
import { blur } from "@orbmeet/ui/styles/surfaces";
import { ink, neutral } from "@orbmeet/ui/tokens/colors.stylex";
import { bp } from "@orbmeet/ui/tokens/media.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";
import { Link, useRouterState } from "@tanstack/react-router";
import { phoneNavItems } from "./nav-items";
import { glass } from "@orbmeet/ui/tokens/wash.stylex";

const styles = stylex.create({
  bar: {
    position: "fixed",
    insetInline: 0,
    bottom: 0,
    zIndex: 40,
    display: { default: "block", [bp.lg]: "none" },
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: neutral.n150,
    backgroundColor: glass.opaque,
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
    paddingInline: space.s1_5,
    paddingTop: space.s1_5,
    paddingBottom: space.s1,
  },
  cell: { display: "block", textDecorationLine: "none" },
  link: {
    // 48px is the smallest comfortable touch target; the icon is smaller than
    // that, so the height is on the link rather than on what you can see.
    display: "flex",
    minHeight: 48,
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: space.s0_5,
    paddingBlock: space.s1_5,
    textDecorationLine: "none",
    fontSize: text.xs,
  },
  idle: { color: ink.muted },
  active: { color: ink.strong, fontWeight: weight.semibold },
});

/**
 * The phone's four places, as tabs along the bottom. Starting a meeting is
 * Home's job, the first thing on it, so the bar has no button of its own.
 */
export function MobileNav() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  return (
    <nav aria-label="Primary navigation" {...stylex.props(styles.bar, blur.xl, safe.padBottom)}>
      <div {...stylex.props(styles.grid)}>
        {phoneNavItems.map((item) => (
          <NavTab key={item.to} item={item} within={"within" in item && pathname.startsWith(item.within)} />
        ))}
      </div>
    </nav>
  );
}

/** One tab: current on its own page, or anywhere under it (`within`). */
function NavTab({ item: { to, label, icon: Icon }, within }: { item: (typeof phoneNavItems)[number]; within: boolean }) {
  return (
    <Link to={to} aria-current={within ? "page" : undefined} {...stylex.props(styles.cell)}>
      {({ isActive }) => (
        <span {...stylex.props(styles.link, motion.tint, isActive || within ? styles.active : styles.idle)}>
          <Icon size={22} strokeWidth={isActive || within ? 2 : 1.75} aria-hidden="true" />
          {label}
        </span>
      )}
    </Link>
  );
}
