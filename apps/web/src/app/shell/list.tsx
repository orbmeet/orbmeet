import { focus, layout, motion } from "@orbmeet/ui/styles/atoms";
import { border, ink, neutral, surface } from "@orbmeet/ui/tokens/colors.stylex";
import { bp, env } from "@orbmeet/ui/tokens/media.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { shadows } from "@orbmeet/ui/tokens/shadows.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { leading, text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";
import type { StyleXStyles } from "@stylexjs/stylex";
import { Link, type RegisteredRouter, type ValidateLinkOptions } from "@tanstack/react-router";
import type { ReactNode } from "react";

const styles = stylex.create({
  list: {
    margin: 0,
    padding: 0,
    listStyle: "none",
    overflow: "hidden",
    borderRadius: radii.card,
    backgroundColor: surface.raised,
    boxShadow: shadows.card,
  },
  item: {
    position: "relative",
    borderTopWidth: { default: 1, ":first-child": 0 },
    borderTopStyle: "solid",
    borderTopColor: border.subtle,
  },
  linked: {
    backgroundColor: {
      default: surface.raised,
      [env.hoverable]: { default: surface.raised, ":hover": neutral.n50 },
    },
  },
  row: {
    display: "flex",
    alignItems: "center",
    gap: space.s3,
    paddingInline: { default: space.s4, [bp.sm]: space.s5 },
    paddingBlock: space.s3_5,
  },
  leading: { flexShrink: 0, display: "flex", alignItems: "center" },
  body: { flexGrow: 1 },
  title: {
    margin: 0,
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: space.s2,
    rowGap: space.s1,
    fontSize: text.sm,
    lineHeight: leading.sm,
    fontWeight: weight.medium,
    color: ink.strong,
  },
  /**
   * The row's link covers the whole row through a pseudo-element, so the row
   * is one big target without nesting the trailing buttons inside an anchor.
   */
  titleLink: {
    color: "inherit",
    textDecorationLine: "none",
    "::after": { content: '""', position: "absolute", inset: 0 },
  },
  meta: {
    marginTop: space.s0_5,
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: space.s2,
    rowGap: space.s1,
    fontSize: text.xs,
    lineHeight: leading.xs,
    color: ink.muted,
  },
  /** Above the stretched link, so its buttons stay clickable. */
  trailing: {
    position: "relative",
    zIndex: 1,
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    gap: space.s1,
  },
  /** A trailing label that collapses to its icon on a phone. */
  wideOnly: { display: { default: "none", [bp.sm]: "inline" } },
  extra: {
    position: "relative",
    zIndex: 1,
    paddingInline: { default: space.s4, [bp.sm]: space.s5 },
    paddingBottom: space.s4,
  },
  /** The small square a row leads with: an icon on a quiet tile. */
  glyph: {
    display: "flex",
    height: 36,
    width: 36,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.control,
    backgroundColor: neutral.n100,
    color: neutral.n600,
  },
});

/** A grouped list: one surface, rows divided by hairlines. */
export function List({ children, sx, label }: { children: ReactNode; sx?: StyleXStyles; label?: string }) {
  return (
    <ul aria-label={label} {...stylex.props(styles.list, sx)}>
      {children}
    </ul>
  );
}

interface ListRowProps<TRouter extends RegisteredRouter = RegisteredRouter, TOptions = unknown> {
  leading?: ReactNode;
  title: ReactNode;
  meta?: ReactNode;
  /** Buttons at the row's end. Stay clickable when the row is a link. */
  trailing?: ReactNode;
  /** Makes the whole row a link to this destination. Checked against the route tree. */
  link?: ValidateLinkOptions<TRouter, TOptions>;
  /** Content that unfolds under the row (attendance, details). */
  children?: ReactNode;
}

/**
 * One item in a `<List>`: a meeting, a file, a whiteboard. Every list in the
 * app uses this row so that "an item" looks the same everywhere it appears.
 */
export function ListRow<TRouter extends RegisteredRouter, TOptions>(
  props: ListRowProps<TRouter, TOptions>,
): ReactNode;
export function ListRow({ leading, title, meta, trailing, link, children }: ListRowProps) {
  return (
    <li {...stylex.props(styles.item, link ? [styles.linked, motion.tint] : null)}>
      <div {...stylex.props(styles.row)}>
        {leading ? <div {...stylex.props(styles.leading)}>{leading}</div> : null}
        <div {...stylex.props(layout.minZero, styles.body)}>
          <p {...stylex.props(styles.title)}>
            {link ? (
              <Link {...link} {...stylex.props(styles.titleLink, focus.ring)}>
                {title}
              </Link>
            ) : (
              title
            )}
          </p>
          {meta ? <div {...stylex.props(styles.meta)}>{meta}</div> : null}
        </div>
        {trailing ? <div {...stylex.props(styles.trailing)}>{trailing}</div> : null}
      </div>
      {children ? <div {...stylex.props(styles.extra)}>{children}</div> : null}
    </li>
  );
}

/** The leading icon tile for a row. */
export function ListGlyph({ children }: { children: ReactNode }) {
  return <span {...stylex.props(styles.glyph)}>{children}</span>;
}

/**
 * Text inside a row action that hides on a phone, leaving the icon. The
 * button keeps its accessible name through `aria-label`.
 */
export function WideOnly({ children }: { children: ReactNode }) {
  return <span {...stylex.props(styles.wideOnly)}>{children}</span>;
}
