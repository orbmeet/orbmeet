import { Tooltip } from "@orbmeet/ui/react";
import { focus, motion, pressable } from "@orbmeet/ui/styles/atoms";
import { accent, live, neutral, surface } from "@orbmeet/ui/tokens/colors.stylex";
import { env } from "@orbmeet/ui/tokens/media.stylex";
import { duration } from "@orbmeet/ui/tokens/motion.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";
import { SpeechWave } from "./dock-primitives";

const styles = stylex.create({
  control: {
    display: "inline-flex",
    flexShrink: 0,
    alignItems: "center",
    gap: space.s2,
    height: 30,
    borderWidth: 0,
    borderRadius: radii.field,
    backgroundColor: { default: "transparent", [env.hoverable]: { default: "transparent", ":hover": neutral.n50 } },
    paddingInline: space.s1_5,
    fontFamily: "inherit",
    fontSize: text.xs,
    fontWeight: weight.semibold,
    whiteSpace: "nowrap",
    color: neutral.n700,
    cursor: "pointer",
  },
  wave: { display: "inline-flex", color: live.l600 },
  track: {
    position: "relative",
    width: 30,
    height: 18,
    flexShrink: 0,
    borderRadius: radii.pill,
    backgroundColor: neutral.n300,
    transitionProperty: "background-color",
    transitionDuration: { default: duration.fast, [env.reducedMotion]: "0s" },
  },
  trackOn: { backgroundColor: accent.a600 },
  thumb: {
    position: "absolute",
    top: 2,
    left: 2,
    width: 14,
    height: 14,
    borderRadius: radii.pill,
    backgroundColor: surface.raised,
    transitionProperty: "transform",
    transitionDuration: { default: duration.fast, [env.reducedMotion]: "0s" },
  },
  thumbOn: { transform: "translateX(12px)" },
});

/**
 * Whether what is said joins the Chat, for this viewer: a switch, named for
 * what it shows. It was a chip reading "Speech shown" beside an unlabelled
 * dashed button, and neither said it could be pressed. It is not called
 * "Transcript": an earlier "Transcript off" was taken for the meeting's
 * transcription, which is a host's to stop (in People), and hiding what is
 * said here stops nothing.
 */
export function SpeechSwitch({
  shown,
  arriving,
  onToggle,
}: {
  shown: boolean;
  /** Someone is talking right now, and it is joining the Chat. */
  arriving: boolean;
  onToggle: () => void;
}) {
  return (
    <Tooltip
      content={
        shown
          ? "Hide what's said from your Chat. It doesn't stop transcription; a host can turn that off in People."
          : "Show what's said in your Chat, as it is said"
      }
      side="bottom"
    >
      <button
        type="button"
        role="switch"
        aria-checked={shown}
        onClick={onToggle}
        {...stylex.props(pressable.base, motion.tint, focus.ring, styles.control)}
      >
        {shown && arriving && (
          <span {...stylex.props(styles.wave)}>
            <SpeechWave />
          </span>
        )}
        Show speech
        <span aria-hidden="true" {...stylex.props(styles.track, shown && styles.trackOn)}>
          <span {...stylex.props(styles.thumb, shown && styles.thumbOn)} />
        </span>
      </button>
    </Tooltip>
  );
}
