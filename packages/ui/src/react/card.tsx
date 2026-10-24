import * as stylex from "@stylexjs/stylex";
import type { StyleXStyles } from "@stylexjs/stylex";
import type { HTMLAttributes, ReactNode } from "react";

import { blur, surfaces } from "../styles/surfaces";
import { motion } from "../styles/atoms";
import { border, neutral, surface } from "../tokens/colors.stylex";
import { radii } from "../tokens/radii.stylex";
import { shadows } from "../tokens/shadows.stylex";
import { space } from "../tokens/space.stylex";
import { glass } from "../tokens/wash.stylex";
import { env } from "../tokens/media.stylex";

type CardVariant = "default" | "elevated" | "outlined" | "glass" | "interactive";

const styles = stylex.create({
  base: {
    borderRadius: radii.card,
    padding: space.s5,
    borderWidth: 1,
    borderStyle: "solid",
  },
  default: {
    backgroundColor: surface.raised,
    borderColor: "transparent",
    boxShadow: shadows.card,
  },
  elevated: {
    backgroundColor: surface.raised,
    borderColor: "transparent",
    boxShadow: shadows.lift2,
  },
  outlined: {
    backgroundColor: "transparent",
    borderColor: neutral.n300,
  },
  glass: {
    backgroundColor: glass.solid,
    borderColor: border.subtle,
    boxShadow: shadows.lift1,
  },
  interactive: {
    backgroundColor: surface.raised,
    borderColor: { default: "transparent", [env.hoverable]: { default: "transparent", ":hover": border.subtle } },
    boxShadow: { default: shadows.card, [env.hoverable]: { default: shadows.card, ":hover": shadows.cardHover } },
    cursor: "pointer",
  },
});

const variants = {
  default: [styles.default],
  elevated: [styles.elevated],
  outlined: [styles.outlined],
  glass: [styles.glass, blur.sm],
  interactive: [styles.interactive, motion.tint],
} as const;

interface CardProps extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style"> {
  variant?: CardVariant;
  children: ReactNode;
  sx?: StyleXStyles;
}

export function Card({ variant = "default", sx, children, ...props }: CardProps) {
  return (
    <div {...props} {...stylex.props(styles.base, variants[variant], sx)}>
      {children}
    </div>
  );
}

/** Re-exported so a page can reach the full surface recipe without a Card. */
export { surfaces as cardSurfaces };
