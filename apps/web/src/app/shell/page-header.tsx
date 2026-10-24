import { enter } from "@orbmeet/ui/styles/animations";
import { layout } from "@orbmeet/ui/styles/atoms";
import { ink } from "@orbmeet/ui/tokens/colors.stylex";
import { bp } from "@orbmeet/ui/tokens/media.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { fonts, leading, text, tracking, weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";
import type { StyleXStyles } from "@stylexjs/stylex";
import type { ReactNode } from "react";

const styles = stylex.create({
  root: { marginBottom: space.s8 },
  back: { marginBottom: space.s5 },
  row: {
    display: "flex",
    flexDirection: { default: "column", [bp.sm]: "row" },
    alignItems: { default: "stretch", [bp.sm]: "flex-end" },
    justifyContent: { default: "flex-start", [bp.sm]: "space-between" },
    gap: space.s4,
  },
  identity: { display: "flex", minWidth: 0, alignItems: "center", gap: space.s4 },
  eyebrow: {
    marginTop: 0,
    marginBottom: space.s1,
    fontSize: text.sm,
    lineHeight: leading.sm,
    fontWeight: weight.medium,
    color: ink.muted,
  },
  title: {
    margin: 0,
    fontFamily: fonts.heading,
    fontSize: { default: text.xl2, [bp.sm]: text.xl3 },
    lineHeight: leading.tight,
    fontWeight: weight.bold,
    letterSpacing: tracking.tight,
    color: ink.strong,
    overflowWrap: "anywhere",
  },
  subtitle: {
    marginTop: space.s1_5,
    marginBottom: 0,
    maxWidth: "40rem",
    fontSize: text.sm,
    lineHeight: leading.relaxed,
    color: ink.muted,
  },
  meta: {
    marginTop: space.s1,
    fontSize: text.sm,
    lineHeight: leading.sm,
    color: ink.muted,
  },
  actions: {
    display: "flex",
    flexShrink: 0,
    flexWrap: "wrap",
    alignItems: "center",
    gap: space.s2,
  },
});

interface PageHeaderProps {
  /** A `<BackLink>` to the collection this page belongs to. */
  back?: ReactNode;
  /** An identity tile beside the title — a Space's colour, say. */
  leading?: ReactNode;
  /** Small label above the title: the Space a Meeting belongs to, "Personal". */
  eyebrow?: ReactNode;
  title: ReactNode;
  /** One line of prose describing the page. */
  subtitle?: ReactNode;
  /** Facts about the object under its title: "3 members", a date. */
  meta?: ReactNode;
  /** Right-aligned actions. At most one of them is `primary`. */
  actions?: ReactNode;
  sx?: StyleXStyles;
}

/**
 * The one header every authenticated page opens with — collections and detail
 * pages alike — so the title sits at the same size, weight and position on
 * every route and the primary action is always in the same corner.
 */
export function PageHeader({
  back,
  leading,
  eyebrow,
  title,
  subtitle,
  meta,
  actions,
  sx,
}: PageHeaderProps) {
  return (
    <header {...stylex.props(styles.root, enter.fadeUp, sx)}>
      {back ? <div {...stylex.props(styles.back)}>{back}</div> : null}
      <div {...stylex.props(styles.row)}>
        <div {...stylex.props(styles.identity)}>
          {leading}
          <div {...stylex.props(layout.minZero)}>
            {eyebrow ? <div {...stylex.props(styles.eyebrow)}>{eyebrow}</div> : null}
            <h1 {...stylex.props(styles.title)}>{title}</h1>
            {subtitle ? <p {...stylex.props(styles.subtitle)}>{subtitle}</p> : null}
            {meta ? <div {...stylex.props(styles.meta)}>{meta}</div> : null}
          </div>
        </div>
        {actions ? <div {...stylex.props(styles.actions)}>{actions}</div> : null}
      </div>
    </header>
  );
}
