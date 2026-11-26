import * as stylex from "@stylexjs/stylex";
import type { StyleXStyles } from "@stylexjs/stylex";
import type { HTMLAttributes, ReactNode } from "react";

import { blur } from "../styles/surfaces";
import { border, surface } from "../tokens/colors.stylex";
import { radii } from "../tokens/radii.stylex";
import { shadows } from "../tokens/shadows.stylex";
import { space } from "../tokens/space.stylex";
import { glass } from "../tokens/wash.stylex";

type CardVariant = "default" | "glass";

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
  glass: {
    backgroundColor: glass.solid,
    borderColor: border.subtle,
    boxShadow: shadows.lift1,
  },
});

const variants = {
  default: [styles.default],
  glass: [styles.glass, blur.sm],
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
