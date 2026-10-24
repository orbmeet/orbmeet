import * as stylex from "@stylexjs/stylex";
import type { StyleXStyles } from "@stylexjs/stylex";
import type { ButtonHTMLAttributes, ReactNode } from "react";

import { focus, motion, pressable } from "../styles/atoms";
import { accent, danger, ink, neutral, surface } from "../tokens/colors.stylex";
import { radii } from "../tokens/radii.stylex";
import { shadows } from "../tokens/shadows.stylex";
import { space } from "../tokens/space.stylex";
import { leading, text, weight } from "../tokens/typography.stylex";
import { env } from "../tokens/media.stylex";
import { Spinner } from "./spinner";

export type ButtonVariant =
  | "primary"
  | "secondary"
  | "ghost"
  | "danger"
  | "outline"
  | "link";

export type ButtonSize = "sm" | "md" | "lg" | "icon" | "iconSm";

const styles = stylex.create({
  base: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    // Daylight's controls are pills: a button reads as something to press, and
    // the round ends keep it apart from the rounded-rectangle rows and cards
    // it sits among.
    borderRadius: radii.pill,
    borderWidth: 0,
    borderStyle: "solid",
    borderColor: "transparent",
    fontFamily: "inherit",
    fontSize: text.sm,
    lineHeight: leading.sm,
    fontWeight: weight.semibold,
    whiteSpace: "nowrap",
  },
});

const variants = stylex.create({
  primary: {
    backgroundColor: {
      default: accent.a600,
      [env.hoverable]: { default: accent.a600, ":hover:not(:disabled)": accent.a700 },
      ":active:not(:disabled)": accent.a800,
    },
    color: ink.onAccent,
    boxShadow: {
      default: shadows.glowPrimary,
      [env.hoverable]: { default: shadows.glowPrimary, ":hover:not(:disabled)": shadows.glowPrimaryHover },
    },
  },
  secondary: {
    borderWidth: 1,
    borderColor: {
      default: neutral.n200,
      [env.hoverable]: { default: neutral.n200, ":hover:not(:disabled)": neutral.n300 },
    },
    backgroundColor: {
      default: surface.raised,
      [env.hoverable]: { default: surface.raised, ":hover:not(:disabled)": neutral.n50 },
    },
    color: neutral.n800,
    boxShadow: {
      default: shadows.lift1,
      [env.hoverable]: { default: shadows.lift1, ":hover:not(:disabled)": shadows.card },
    },
  },
  ghost: {
    backgroundColor: {
      default: "transparent",
      [env.hoverable]: { default: "transparent", ":hover:not(:disabled)": neutral.n100 },
    },
    color: {
      default: neutral.n600,
      [env.hoverable]: { default: neutral.n600, ":hover:not(:disabled)": neutral.n900 },
    },
  },
  danger: {
    backgroundColor: {
      default: danger.d600,
      [env.hoverable]: { default: danger.d600, ":hover:not(:disabled)": danger.d700 },
      ":active:not(:disabled)": danger.d800,
    },
    color: ink.onDark,
    boxShadow: shadows.lift1,
  },
  outline: {
    borderWidth: 1,
    borderColor: {
      default: accent.a300,
      [env.hoverable]: { default: accent.a300, ":hover:not(:disabled)": accent.a400 },
    },
    backgroundColor: {
      default: "transparent",
      [env.hoverable]: { default: "transparent", ":hover:not(:disabled)": accent.a50 },
    },
    color: accent.a700,
  },
  /**
   * A button that is really a link. It drops the box entirely — no height, no
   * padding — so it sits inside a sentence at the text's own baseline.
   */
  link: {
    color: accent.a700,
    backgroundColor: "transparent",
    padding: 0,
    height: "auto",
    // Its text's height for a pointer; a row a thumb can land on under a finger.
    minHeight: { default: null, [env.touch]: 44 },
    textDecorationLine: {
      default: "none",
      [env.hoverable]: { default: "none", ":hover:not(:disabled)": "underline" },
    },
    textUnderlineOffset: 4,
  },
});

const sizes = stylex.create({
  sm: { height: 32, paddingInline: space.s3, fontSize: text.xs, gap: space.s1_5 },
  md: { height: 40, paddingInline: space.s4, gap: space.s2 },
  lg: { height: 48, paddingInline: space.s6, fontSize: text.base, gap: space.s2 },
  icon: { height: 40, width: 40, padding: 0 },
  /** A row action: the icon button at the end of a list row. */
  iconSm: { height: 32, width: 32, padding: 0 },
});

export interface ButtonVariantsProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  sx?: StyleXStyles;
}

/**
 * The button's styles as a list, for elements that are not `<button>`.
 *
 * A router `<Link>` that should look like a primary button spreads
 * `stylex.props(...buttonStyles({ variant: "primary" }))` rather than
 * reimplementing the surface. This replaces the old `buttonVariants()`
 * class-string helper, and unlike it the result composes: a caller can append
 * its own overrides through `sx` and they win.
 */
export function buttonStyles({
  variant = "primary",
  size = "md",
  sx,
}: ButtonVariantsProps = {}) {
  return [
    styles.base,
    pressable.base,
    pressable.sink,
    motion.press,
    focus.ring,
    // `link` sizes itself off the surrounding text, so the step scale is
    // deliberately skipped for it.
    variant === "link" ? null : sizes[size],
    variants[variant],
    sx,
  ] as const;
}

interface ButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "style">,
    ButtonVariantsProps {
  loading?: boolean;
  children?: ReactNode;
}

export function Button({
  sx,
  variant,
  size,
  loading,
  disabled,
  type,
  children,
  ...props
}: ButtonProps) {
  const isDisabled = disabled || loading;
  return (
    // Native <button> instead of @base-ui's Button: this component never exposes
    // base-ui-specific props (render/nativeButton), so pulling the whole base-ui
    // runtime onto every page that uses a button was dead weight (~80KB + surface-core
    // on the marketing/auth pages). Preserve the behaviour base-ui gave us: a
    // default type="button", since native defaults to "submit" inside a form.
    <button
      type={type ?? "button"}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      {...props}
      {...stylex.props(...buttonStyles({ variant, size, sx }))}
    >
      {loading ? (
        <>
          <Spinner decorative size="sm" />
          {children}
        </>
      ) : (
        children
      )}
    </button>
  );
}
