import { layout, motion } from "@orbmeet/ui/styles/atoms";
import { accent, ink, neutral, surface } from "@orbmeet/ui/tokens/colors.stylex";
import { bp, env } from "@orbmeet/ui/tokens/media.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { leading, text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";
import { ShieldCheck } from "lucide-react";

const styles = stylex.create({
  fieldset: { borderWidth: 0, margin: 0, padding: 0, minInlineSize: 0 },
  fieldsetDisabled: { opacity: 0.6 },
  legend: {
    display: "flex",
    alignItems: "center",
    gap: space.s2,
    padding: 0,
    fontSize: text.sm,
    lineHeight: leading.sm,
    fontWeight: weight.medium,
    color: neutral.n700,
  },
  legendGlyph: { color: neutral.n500 },
  options: {
    marginTop: space.s2,
    display: "grid",
    gap: space.s2,
    gridTemplateColumns: { default: "1fr", [bp.sm]: "repeat(2, minmax(0, 1fr))" },
  },
  /**
   * The whole card is the label, so the hit target is the option rather than a
   * 16px circle beside it. `:has(:focus-visible)` puts the focus ring on the
   * card when the visually hidden radio inside it takes focus.
   */
  option: {
    display: "flex",
    alignItems: "flex-start",
    gap: space.s2_5,
    borderRadius: radii.field,
    borderWidth: 1,
    borderStyle: "solid",
    padding: space.s2_5,
    boxShadow: {
      default: "none",
      ":has(:focus-visible)": `0 0 0 2px color-mix(in oklab, ${accent.a500} 30%, transparent)`,
    },
  },
  optionIdle: {
    borderColor: { default: neutral.n200, [env.hoverable]: { default: neutral.n200, ":hover": neutral.n300 } },
    backgroundColor: surface.raised,
  },
  optionSelected: { borderColor: accent.a300, backgroundColor: accent.a50 },
  optionEnabled: { cursor: "pointer" },
  optionDisabled: { cursor: "not-allowed" },

  /** The radio itself is drawn, not native — but the real input still exists. */
  mark: {
    marginTop: space.s0_5,
    display: "flex",
    height: 16,
    width: 16,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.pill,
    borderWidth: 1,
    borderStyle: "solid",
  },
  markIdle: { borderColor: neutral.n300 },
  markSelected: { borderColor: accent.a600 },
  markDot: { height: 8, width: 8, borderRadius: radii.pill, backgroundColor: accent.a600 },

  copy: { display: "flex", flexDirection: "column" },
  optionLabel: { fontSize: text.sm, fontWeight: weight.medium, color: neutral.n800 },
  optionDescription: { fontSize: text.xs, color: ink.muted },
});

export type EntryModeChoice = "open" | "approval_required";
export type MeetingAudience = "link" | "space";

/**
 * Entry behavior is separate from audience. A personal link may be shared
 * with anyone, while a Space is always limited to current members; this field
 * only controls whether eligible people enter immediately or wait for approval.
 */

function entryModeOptions(audience: MeetingAudience) {
  return audience === "space"
    ? [
        {
          value: "open",
          label: "Any Space member",
          description: "Members enter as soon as they open the Space link.",
        },
        {
          value: "approval_required",
          label: "Members you admit",
          description: "Space members wait until you let them in.",
        },
      ] as const
    : [
        {
          value: "open",
          label: "Anyone with the link",
          description: "People enter as soon as they open it.",
        },
        {
          value: "approval_required",
          label: "People you admit",
          description: "Everyone waits until you let them in.",
        },
      ] as const;
}

export function MeetingEntryModeField({
  value,
  onChange,
  name,
  audience = "link",
  disabled = false,
}: {
  value: EntryModeChoice;
  onChange: (value: EntryModeChoice) => void;
  /** Unique radio-group name — two instances may be mounted at once. */
  name: string;
  audience?: MeetingAudience;
  disabled?: boolean;
}) {
  const options = entryModeOptions(audience);
  return (
    <fieldset
      disabled={disabled}
      {...stylex.props(styles.fieldset, disabled && styles.fieldsetDisabled)}
    >
      <legend {...stylex.props(styles.legend)}>
        <ShieldCheck size={16} {...stylex.props(styles.legendGlyph)} />
        How eligible people enter
      </legend>
      <div {...stylex.props(styles.options)}>
        {options.map((option) => {
          const selected = value === option.value;
          return (
            <label
              key={option.value}
              {...stylex.props(
                styles.option,
                motion.tint,
                disabled ? styles.optionDisabled : styles.optionEnabled,
                selected ? styles.optionSelected : styles.optionIdle,
              )}
            >
              <input
                type="radio"
                name={name}
                value={option.value}
                checked={selected}
                onChange={() => onChange(option.value)}
                {...stylex.props(layout.srOnly)}
              />
              <span
                aria-hidden
                {...stylex.props(styles.mark, selected ? styles.markSelected : styles.markIdle)}
              >
                {selected && <span {...stylex.props(styles.markDot)} />}
              </span>
              <span {...stylex.props(styles.copy)}>
                <span {...stylex.props(styles.optionLabel)}>{option.label}</span>
                <span {...stylex.props(styles.optionDescription)}>{option.description}</span>
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
