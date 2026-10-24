import * as stylex from "@stylexjs/stylex";
import type { StyleXStyles } from "@stylexjs/stylex";
import type { ComponentType, ReactNode } from "react";

import { enter } from "../styles/animations";
import { ink, neutral } from "../tokens/colors.stylex";
import { radii } from "../tokens/radii.stylex";
import { measure, space } from "../tokens/space.stylex";
import { leading, text, weight } from "../tokens/typography.stylex";

const styles = stylex.create({
  root: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    paddingBlock: space.s16,
    textAlign: "center",
  },
  illustration: { marginBottom: space.s6 },
  iconWell: {
    marginBottom: space.s4,
    borderRadius: radii.panel,
    backgroundColor: neutral.n100,
    padding: space.s4,
    color: neutral.n500,
    display: "inline-flex",
  },
  title: {
    margin: 0,
    fontSize: text.base,
    lineHeight: leading.base,
    fontWeight: weight.semibold,
    color: ink.strong,
  },
  description: {
    marginTop: space.s1,
    marginBottom: 0,
    maxWidth: measure.form,
    fontSize: text.sm,
    lineHeight: leading.relaxed,
    color: ink.muted,
  },
  action: { marginTop: space.s4 },
});

interface EmptyStateProps {
  /**
   * The heading level. `h3` suits the common case — an empty panel inside a
   * page that already has an `h1` — but an empty state that *is* the whole
   * page needs to be that page's `h1`, or the document starts at level 3 with
   * nothing above it.
   */
  titleAs?: "h1" | "h2" | "h3";
  /**
   * Rendered inside a neutral well. The icon is coloured by the well, so a
   * caller passing a Lucide glyph gets the right tint without saying so.
   */
  icon?: ComponentType<{ size?: number }>;
  illustration?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  sx?: StyleXStyles;
}

export function EmptyState({
  icon: Icon,
  illustration,
  title,
  titleAs: Title = "h3",
  description,
  action,
  sx,
}: EmptyStateProps) {
  return (
    <div {...stylex.props(styles.root, enter.fadeUp, sx)}>
      {illustration ? (
        <div {...stylex.props(styles.illustration)}>{illustration}</div>
      ) : Icon ? (
        <div {...stylex.props(styles.iconWell)}>
          <Icon size={32} />
        </div>
      ) : null}
      <Title {...stylex.props(styles.title)}>{title}</Title>
      {description && <p {...stylex.props(styles.description)}>{description}</p>}
      {action && <div {...stylex.props(styles.action)}>{action}</div>}
    </div>
  );
}
