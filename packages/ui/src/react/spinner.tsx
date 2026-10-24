import * as stylex from "@stylexjs/stylex";
import type { StyleXStyles } from "@stylexjs/stylex";

import { spinner } from "../styles/animations";

const sizes = {
  sm: spinner.sm,
  md: spinner.md,
  lg: spinner.lg,
} as const;

interface SpinnerProps {
  size?: keyof typeof sizes;
  brand?: boolean;
  /**
   * Style overrides. Named `sx` rather than `style` throughout this package:
   * `style` is React's inline-style prop and several of these components
   * forward it to the DOM, so the two must not share a name.
   */
  sx?: StyleXStyles;
  /** Accessible name announced to screen readers. */
  label?: string;
  /**
   * Set when an ancestor already conveys the busy state (e.g. a button with
   * `aria-busy`) so screen readers don't announce a duplicate "Loading".
   */
  decorative?: boolean;
}

export function Spinner({
  size = "md",
  brand = false,
  sx,
  label = "Loading",
  decorative = false,
}: SpinnerProps) {
  return (
    <div
      role={decorative ? undefined : "status"}
      aria-label={decorative ? undefined : label}
      aria-hidden={decorative || undefined}
      {...stylex.props(
        spinner.ring,
        sizes[size],
        brand ? spinner.brand : spinner.neutral,
        sx,
      )}
    />
  );
}
