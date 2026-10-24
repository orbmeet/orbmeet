import * as stylex from "@stylexjs/stylex";
import type { StyleXStyles } from "@stylexjs/stylex";
import { X } from "lucide-react";
import type { ReactNode } from "react";

import { accent, danger, neutral, success, warning } from "../tokens/colors.stylex";
import { duration, easing } from "../tokens/motion.stylex";
import { env } from "../tokens/media.stylex";
import { radii } from "../tokens/radii.stylex";
import { space } from "../tokens/space.stylex";
import { leading, text, weight } from "../tokens/typography.stylex";
import { scrim } from "../tokens/wash.stylex";

type BadgeVariant = "default" | "primary" | "success" | "warning" | "danger" | "accent";
type BadgeSize = "sm" | "md";

const styles = stylex.create({
  base: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.s1,
    borderRadius: radii.pill,
    fontWeight: weight.medium,
    borderWidth: 0,
    borderStyle: "solid",
    borderColor: "transparent",
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
  /** Outline variants trade the fill for a hairline. */
  outlined: { borderWidth: 1, backgroundColor: "transparent" },

  dot: {
    width: 6,
    height: 6,
    borderRadius: radii.pill,
    flexShrink: 0,
  },

  remove: {
    marginInlineStart: space.s0_5,
    marginInlineEnd: `calc(-1 * ${space.s0_5})`,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    padding: space.s0_5,
    borderWidth: 0,
    borderRadius: radii.pill,
    backgroundColor: { default: "transparent", [env.hoverable]: { default: "transparent", ":hover": `${scrim.edge}` } },
    color: "inherit",
    cursor: "pointer",
    transitionProperty: "background-color",
    transitionDuration: { default: duration.instant, [env.reducedMotion]: "0s" },
    transitionTimingFunction: easing.stiff,
  },
});

/**
 * Per-variant colour, split by fill state.
 *
 * A lookup of style namespaces rather than a `compoundVariants` table: the
 * variant and the outline flag are the only two axes, and StyleX merges the
 * two selected namespaces without a matrix.
 */
const fills = stylex.create({
  default: { backgroundColor: neutral.n100, color: neutral.n700 },
  primary: { backgroundColor: accent.a100, color: accent.a700 },
  accent: { backgroundColor: accent.a100, color: accent.a700 },
  success: { backgroundColor: success.s100, color: success.s700 },
  warning: { backgroundColor: warning.w100, color: warning.w700 },
  danger: { backgroundColor: danger.d100, color: danger.d700 },
});

const outlines = stylex.create({
  default: { borderColor: neutral.n300, color: neutral.n600 },
  primary: { borderColor: accent.a300, color: accent.a600 },
  accent: { borderColor: accent.a300, color: accent.a600 },
  success: { borderColor: success.s300, color: success.s600 },
  warning: { borderColor: warning.w300, color: warning.w600 },
  danger: { borderColor: danger.d300, color: danger.d600 },
});

const dots = stylex.create({
  default: { backgroundColor: neutral.n400 },
  primary: { backgroundColor: accent.a500 },
  accent: { backgroundColor: accent.a500 },
  success: { backgroundColor: success.s500 },
  warning: { backgroundColor: warning.w500 },
  danger: { backgroundColor: danger.d500 },
});

interface BadgeProps {
  variant?: BadgeVariant;
  size?: BadgeSize;
  outline?: boolean;
  children: ReactNode;
  dot?: boolean;
  removable?: boolean;
  onRemove?: () => void;
  sx?: StyleXStyles;
}

export function Badge({
  children,
  variant = "default",
  size = "md",
  outline = false,
  dot = false,
  removable = false,
  onRemove,
  sx,
}: BadgeProps) {
  return (
    <span
      {...stylex.props(
        styles.base,
        size === "sm" ? styles.sm : styles.md,
        outline ? [styles.outlined, outlines[variant]] : fills[variant],
        sx,
      )}
    >
      {dot && <span {...stylex.props(styles.dot, dots[variant])} />}
      {children}
      {removable && (
        <button type="button" onClick={onRemove} aria-label="Remove" {...stylex.props(styles.remove)}>
          <X size={10} />
        </button>
      )}
    </span>
  );
}
