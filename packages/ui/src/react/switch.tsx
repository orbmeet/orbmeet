import * as stylex from "@stylexjs/stylex";

import { focus } from "../styles/atoms";
import { accent, ink, neutral, surface } from "../tokens/colors.stylex";
import { env } from "../tokens/media.stylex";
import { radii } from "../tokens/radii.stylex";

const styles = stylex.create({
  track: {
    position: "relative",
    flexShrink: 0,
    width: 40,
    height: 24,
    borderWidth: 0,
    borderRadius: radii.pill,
    padding: 0,
    backgroundColor: neutral.n300,
    cursor: { default: "pointer", ":disabled": "wait" },
    transitionProperty: "background-color",
    transitionDuration: { default: "150ms", [env.reducedMotion]: "0s" },
    // The track is drawn 40×24; under a finger it answers 60×44, the same size
    // on screen with room around it to land on.
    "::after": {
      content: '""',
      position: "absolute",
      inset: { default: 0, [env.touch]: "-10px" },
    },
  },
  trackOn: { backgroundColor: accent.a600 },
  thumb: {
    position: "absolute",
    top: 3,
    left: 3,
    width: 18,
    height: 18,
    borderRadius: radii.pill,
    backgroundColor: surface.raised,
    boxShadow: `0 1px 2px color-mix(in oklab, ${ink.strong} 25%, transparent)`,
    transitionProperty: "translate",
    transitionDuration: { default: "150ms", [env.reducedMotion]: "0s" },
  },
  thumbOn: { translate: "16px 0" },
});

/**
 * An on/off control. It has no label of its own: name it with
 * `aria-labelledby` (or `aria-label`) from the text beside it. `pending`
 * disables it while a change is on its way.
 */
export function Switch({
  checked,
  pending = false,
  onCheckedChange,
  ...labelling
}: {
  checked: boolean;
  pending?: boolean;
  onCheckedChange: (checked: boolean) => void;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  "aria-label"?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={pending}
      onClick={() => onCheckedChange(!checked)}
      {...labelling}
      {...stylex.props(focus.ring, styles.track, checked && styles.trackOn)}
    >
      <span aria-hidden="true" {...stylex.props(styles.thumb, checked && styles.thumbOn)} />
    </button>
  );
}
