import * as stylex from "@stylexjs/stylex";
import type { StyleXStyles } from "@stylexjs/stylex";
import { Search } from "lucide-react";

import { motion } from "../styles/atoms";
import { accent, neutral } from "../tokens/colors.stylex";
import { bp, env } from "../tokens/media.stylex";
import { radii } from "../tokens/radii.stylex";
import { shadows } from "../tokens/shadows.stylex";
import { space } from "../tokens/space.stylex";
import { leading, text } from "../tokens/typography.stylex";
import { glass } from "../tokens/wash.stylex";

const styles = stylex.create({
  root: { position: "relative", width: "100%" },
  /** Inline in a header row: full-width on a phone, a fixed column above it. */
  inline: { width: { default: "100%", [bp.sm]: 256 } },
  icon: {
    pointerEvents: "none",
    position: "absolute",
    left: space.s3,
    top: "50%",
    transform: "translateY(-50%)",
    color: neutral.n400,
  },
  input: {
    height: 40,
    width: "100%",
    borderRadius: radii.control,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: { default: neutral.n200, ":focus": accent.a400 },
    backgroundColor: glass.panel,
    paddingLeft: space.s10,
    paddingRight: space.s4,
    fontFamily: "inherit",
    // 16px under a finger: iOS zooms the page into a smaller focused field (see styles.css).
    fontSize: { default: text.sm, [env.touch]: text.base },
    lineHeight: leading.sm,
    color: neutral.n800,
    boxShadow: {
      default: shadows.lift1,
      ":focus": `${shadows.lift1}, 0 0 0 2px color-mix(in oklab, ${accent.a500} 20%, transparent)`,
    },
    outlineStyle: "none",
    "::placeholder": { color: neutral.n500 },
  },
});

interface FilterInputProps {
  value: string;
  onChange: (value: string) => void;
  /**
   * Accessible name. Required because a placeholder is not one — it disappears
   * the moment someone types and is not reliably announced.
   */
  label: string;
  placeholder?: string;
  sx?: StyleXStyles;
  /** Wrapper width — inline (in a header) vs full-width (below a header). */
  width?: "sm" | "full";
}

/**
 * The search/filter input shared by Spaces and Whiteboards.
 */
export function FilterInput({
  value,
  onChange,
  label,
  placeholder = "Search…",
  sx,
  width = "sm",
}: FilterInputProps) {
  return (
    <div {...stylex.props(styles.root, width === "sm" && styles.inline, sx)}>
      <Search size={14} {...stylex.props(styles.icon)} />
      <input
        type="search"
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        {...stylex.props(styles.input, motion.tint)}
      />
    </div>
  );
}
