import { Field } from "@base-ui/react/field";
import * as stylex from "@stylexjs/stylex";
import type { StyleXStyles } from "@stylexjs/stylex";
import type { InputHTMLAttributes, ReactNode, Ref } from "react";

import { motion } from "../styles/atoms";
import { accent, danger, ink, neutral, surface } from "../tokens/colors.stylex";
import { env } from "../tokens/media.stylex";
import { radii } from "../tokens/radii.stylex";
import { space } from "../tokens/space.stylex";
import { leading, text, weight } from "../tokens/typography.stylex";

const styles = stylex.create({
  root: { width: "100%" },
  label: {
    marginBottom: space.s1_5,
    display: "block",
    fontSize: text.sm,
    lineHeight: leading.sm,
    fontWeight: weight.medium,
    color: neutral.n700,
  },
  wrap: { position: "relative" },
  adornment: {
    pointerEvents: "none",
    position: "absolute",
    top: "50%",
    transform: "translateY(-50%)",
    display: "flex",
    alignItems: "center",
    color: neutral.n500,
  },
  adornmentLeft: { left: space.s3 },
  adornmentRight: { right: space.s3 },

  control: {
    display: "flex",
    height: 40,
    width: "100%",
    borderRadius: radii.field,
    borderWidth: 1,
    borderStyle: "solid",
    paddingInline: space.s3,
    paddingBlock: space.s2,
    fontFamily: "inherit",
    // 16px under a finger: iOS zooms the page into a smaller focused field (see styles.css).
    fontSize: { default: text.sm, [env.touch]: text.base },
    lineHeight: leading.sm,
    color: { default: ink.strong, ":disabled": ink.muted },
    outlineStyle: "none",
    cursor: { default: "auto", ":disabled": "not-allowed" },
    /**
     * A disabled field says so with an inert ground, not by fading its content.
     *
     * The blanket `opacity: 0.5` rendered a real value at 3.41:1 on white —
     * below AA — and at roughly the same weight as a placeholder, so a
     * disabled-but-filled field (the account email, which is displayed exactly
     * because it cannot be changed) read as an empty one. Muted ink on a filled
     * ground is 4.97:1 and unmistakably a value.
     */
    backgroundColor: { default: surface.raised, ":disabled": neutral.n100 },
    // The placeholder grey every other field uses: at n500 a hint such as a
    // page range's "1" and "5" read as values someone had already typed.
    "::placeholder": { color: neutral.n400 },
  },
  /**
   * Focus is drawn as a border colour change plus a ring-shaped box-shadow
   * rather than an outline, because the control sits flush inside a rounded
   * field and an offset outline would collide with the adornments.
   */
  ok: {
    // A disabled field drops its edge too: in the dark theme its filled ground
    // is a shade off the page, and the border was what made it look editable.
    borderColor: { default: neutral.n300, ":focus-visible": accent.a400, ":disabled": "transparent" },
    boxShadow: {
      default: "none",
      ":focus-visible": `0 0 0 2px color-mix(in oklab, ${accent.a500} 20%, transparent)`,
    },
  },
  invalid: {
    borderColor: { default: danger.d300, ":focus-visible": danger.d500 },
    boxShadow: {
      default: "none",
      ":focus-visible": `0 0 0 2px color-mix(in oklab, ${danger.d500} 20%, transparent)`,
    },
  },
  padLeft: { paddingLeft: space.s10 },
  padRight: { paddingRight: space.s10 },

  error: {
    marginTop: space.s1_5,
    fontSize: text.sm,
    lineHeight: leading.sm,
    color: danger.d600,
  },
});

/**
 * An input must have an accessible name, and a placeholder is not one — it
 * disappears the moment someone types and is not reliably announced. The union
 * makes that a type error rather than an audit finding: a caller supplies a
 * visible `label`, an `aria-label`, or an `aria-labelledby`.
 */
type AccessibleName =
  | { label: ReactNode; "aria-label"?: string; "aria-labelledby"?: string }
  | { label?: never; "aria-label": string; "aria-labelledby"?: string }
  | { label?: never; "aria-label"?: string; "aria-labelledby": string };

type InputProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "aria-label" | "aria-labelledby" | "className" | "style"
> &
  AccessibleName & {
    error?: string;
    leftIcon?: ReactNode;
    rightIcon?: ReactNode;
    sx?: StyleXStyles;
    ref?: Ref<HTMLInputElement>;
  };

export function Input({ ref, sx, label, error, leftIcon, rightIcon, name, id, ...props }: InputProps) {
  return (
    <Field.Root invalid={!!error} name={name} {...stylex.props(styles.root)}>
      {label && <Field.Label {...stylex.props(styles.label)}>{label}</Field.Label>}
      <div {...stylex.props(styles.wrap)}>
        {leftIcon && (
          <div {...stylex.props(styles.adornment, styles.adornmentLeft)}>{leftIcon}</div>
        )}
        <Field.Control
          ref={ref}
          id={id}
          {...props}
          {...stylex.props(
            styles.control,
            motion.tint,
            error ? styles.invalid : styles.ok,
            leftIcon ? styles.padLeft : null,
            rightIcon ? styles.padRight : null,
            sx,
          )}
        />
        {rightIcon && (
          <div {...stylex.props(styles.adornment, styles.adornmentRight)}>{rightIcon}</div>
        )}
      </div>
      {error && (
        <Field.Error match {...stylex.props(styles.error)}>
          {error}
        </Field.Error>
      )}
    </Field.Root>
  );
}
