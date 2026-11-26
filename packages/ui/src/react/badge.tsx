import * as stylex from "@stylexjs/stylex";
import type { StyleXStyles } from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { accent, neutral, success, warning } from "../tokens/colors.stylex";
import { radii } from "../tokens/radii.stylex";
import { space } from "../tokens/space.stylex";
import { leading, text, weight } from "../tokens/typography.stylex";

type BadgeVariant = "default" | "primary" | "success" | "warning";
type BadgeSize = "sm" | "md";

const styles = stylex.create({
  base: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.s1,
    borderRadius: radii.pill,
    fontWeight: weight.medium,
  },
  sm: {
    paddingInline: space.s1_5,
    paddingBlock: space.s0_5,
    fontSize: text.xs2,
    lineHeight: leading.xs2,
  },
  md: {
    paddingInline: space.s2,
    paddingBlock: space.s0_5,
    fontSize: text.xs,
    lineHeight: leading.xs,
  },
});

const fills = stylex.create({
  default: { backgroundColor: neutral.n100, color: neutral.n700 },
  primary: { backgroundColor: accent.a100, color: accent.a700 },
  success: { backgroundColor: success.s100, color: success.s700 },
  warning: { backgroundColor: warning.w100, color: warning.w700 },
});

interface BadgeProps {
  variant?: BadgeVariant;
  size?: BadgeSize;
  children: ReactNode;
  sx?: StyleXStyles;
}

export function Badge({
  children,
  variant = "default",
  size = "md",
  sx,
}: BadgeProps) {
  return (
    <span
      {...stylex.props(
        styles.base,
        size === "sm" ? styles.sm : styles.md,
        fills[variant],
        sx,
      )}
    >
      {children}
    </span>
  );
}
