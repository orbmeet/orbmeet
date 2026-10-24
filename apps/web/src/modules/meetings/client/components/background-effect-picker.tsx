import { motion, pressable } from "@orbmeet/ui/styles/atoms";
import { accent, ink, neutral, surface } from "@orbmeet/ui/tokens/colors.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";
import type { StyleXStyles } from "@stylexjs/stylex";
import { ImageOff, Sparkles } from "lucide-react";

import { PRESET_BACKGROUNDS, type BackgroundMode } from "@/modules/meetings/client/use-background-effect";
import { glass, scrim } from "@orbmeet/ui/tokens/wash.stylex";
import { env } from "@orbmeet/ui/tokens/media.stylex";

/**
 * The picker appears in two places with two grounds under it: floating over the
 * dark room as a popover, and inside a light bottom sheet on a phone. `variant`
 * is which of those it is standing on — everything else about it is the same.
 */
type PickerVariant = "dark" | "light";

const styles = stylex.create({
  root: { width: 256, padding: space.s3 },
  heading: {
    marginTop: 0,
    marginBottom: space.s2,
    fontSize: text.xs,
    fontWeight: weight.medium,
  },
  headingLight: { color: ink.muted },
  headingDark: { color: `${glass.sheer}` },

  /**
   * Three across, scrolling after four rows. The tiles are 16:9 because they
   * stand for the camera frame, not for a swatch.
   */
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
    gap: space.s2,
    maxHeight: 288,
    overflowY: "auto",
    overscrollBehavior: "contain",
  },

  tile: {
    position: "relative",
    display: "flex",
    aspectRatio: "16 / 9",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    borderRadius: radii.field,
    borderWidth: 2,
    borderStyle: "solid",
  },
  tileLight: {
    backgroundColor: neutral.n50,
    borderColor: { default: neutral.n200, [env.hoverable]: { default: neutral.n200, ":hover:not(:disabled)": neutral.n300 } },
  },
  tileDark: {
    backgroundColor: "transparent",
    borderColor: {
      default: glass.veil,
      [env.hoverable]: { default: glass.veil, ":hover:not(:disabled)": `color-mix(in oklab, ${surface.raised} 30%, transparent)` },
    },
  },
  /**
   * Restates the hover step from `tileLight`/`tileDark`. StyleX merges a
   * property's conditional variants as one unit, so a flat `borderColor` here
   * would silently drop the hover the unselected tiles have.
   */
  tileSelected: {
    borderColor: {
      default: accent.a500,
      [env.hoverable]: { default: accent.a500, ":hover:not(:disabled)": accent.a600 },
    },
    boxShadow: `0 0 0 1px color-mix(in oklab, ${accent.a500} 40%, transparent)`,
  },
  tileDisabled: { pointerEvents: "none", opacity: 0.5 },
  tileGlyphLight: { color: ink.muted },
  tileGlyphDark: { color: `color-mix(in oklab, ${surface.raised} 50%, transparent)` },
  preview: { height: "100%", width: "100%", borderRadius: radii.field, objectFit: "cover" },

  /** A caption band across the bottom of a tile, for the two that have no image. */
  caption: {
    position: "absolute",
    insetInline: 0,
    bottom: 0,
    paddingBlock: space.s0_5,
    textAlign: "center",
    fontSize: text.xs2,
    fontWeight: weight.medium,
  },
  captionLight: { backgroundColor: `${glass.panel}`, color: neutral.n700 },
  captionDark: { backgroundColor: `${scrim.backdrop}`, color: ink.onDark },
});

interface BackgroundEffectPickerProps {
  mode: BackgroundMode;
  imagePath: string | null;
  isProcessing: boolean;
  variant?: PickerVariant;
  /** Overrides the picker's fixed width — sheets want the full sheet width. */
  sx?: StyleXStyles;
  onSelectNone: () => void;
  onSelectBlur: () => void;
  onSelectImage: (path: string) => void;
}

export function BackgroundEffectPicker({
  mode,
  imagePath,
  isProcessing,
  variant = "dark",
  sx,
  onSelectNone,
  onSelectBlur,
  onSelectImage,
}: BackgroundEffectPickerProps) {
  const isLight = variant === "light";

  return (
    <div {...stylex.props(styles.root, sx)}>
      <p {...stylex.props(styles.heading, isLight ? styles.headingLight : styles.headingDark)}>
        Background
      </p>

      <div {...stylex.props(styles.grid)}>
        <OptionTile
          selected={mode === "none"}
          disabled={isProcessing}
          onClick={onSelectNone}
          label="None"
          variant={variant}
        >
          <ImageOff
            size={20}
            {...stylex.props(isLight ? styles.tileGlyphLight : styles.tileGlyphDark)}
          />
        </OptionTile>

        <OptionTile
          selected={mode === "blur"}
          disabled={isProcessing}
          onClick={onSelectBlur}
          label="Blur"
          variant={variant}
        >
          <Sparkles
            size={20}
            {...stylex.props(isLight ? styles.tileGlyphLight : styles.tileGlyphDark)}
          />
        </OptionTile>

        {PRESET_BACKGROUNDS.map((bg) => (
          <OptionTile
            key={bg}
            selected={mode === "image" && imagePath === bg}
            disabled={isProcessing}
            onClick={() => onSelectImage(bg)}
            variant={variant}
          >
            <img src={bg} alt="" loading="lazy" {...stylex.props(styles.preview)} />
          </OptionTile>
        ))}
      </div>
    </div>
  );
}

function OptionTile({
  selected,
  disabled,
  onClick,
  label,
  variant = "dark",
  children,
}: {
  selected: boolean;
  disabled: boolean;
  onClick: () => void;
  label?: string;
  variant?: PickerVariant;
  children: React.ReactNode;
}) {
  const isLight = variant === "light";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      {...stylex.props(
        pressable.base,
        motion.tint,
        styles.tile,
        isLight ? styles.tileLight : styles.tileDark,
        selected && styles.tileSelected,
        disabled && styles.tileDisabled,
      )}
    >
      {children}
      {label && (
        <span
          {...stylex.props(styles.caption, isLight ? styles.captionLight : styles.captionDark)}
        >
          {label}
        </span>
      )}
    </button>
  );
}
