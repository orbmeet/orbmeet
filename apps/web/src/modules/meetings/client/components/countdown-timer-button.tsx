import { motion, pressable, row } from "@orbmeet/ui/styles/atoms";
import { danger, ink, neutral } from "@orbmeet/ui/tokens/colors.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { leading, text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";

import { dockPopover } from "@/modules/meetings/client/meeting-styles";
import type { SharedCountdownState } from "@/modules/meetings/client/use-shared-countdown";
import { env } from "@orbmeet/ui/tokens/media.stylex";
import { formatClock } from "@/modules/meetings/client/format-duration";

const styles = stylex.create({
  heading: {
    marginTop: 0,
    marginBottom: space.s2,
    fontSize: text.xs,
    fontWeight: weight.medium,
    color: neutral.n700,
  },
  /** The live readout, in the panel. Monospaced so it does not shuffle. */
  readout: {
    marginTop: 0,
    marginBottom: space.s2,
    fontVariantNumeric: "tabular-nums",
    fontSize: text.lg,
    fontWeight: weight.semibold,
    color: neutral.n900,
  },
  note: { margin: 0, fontSize: text.xs, lineHeight: leading.sm, color: neutral.n600 },
  /** Six preset lengths, three to a row. */
  presets: {
    marginBottom: space.s2,
    display: "grid",
    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
    gap: space.s1,
  },
  preset: {
    borderWidth: 0,
    borderRadius: radii.control,
    backgroundColor: { default: neutral.n100, [env.hoverable]: { default: neutral.n100, ":hover": neutral.n200 } },
    paddingInline: space.s2,
    paddingBlock: space.s1_5,
    fontFamily: "inherit",
    fontSize: text.xs,
    color: neutral.n700,
  },
  customRow: { gap: space.s1 },
  customField: { flexGrow: 1, paddingBlock: space.s1_5, paddingInline: space.s2 },
  startButton: {
    borderWidth: 0,
    borderRadius: radii.control,
    backgroundColor: { default: neutral.n800, [env.hoverable]: { default: neutral.n800, ":hover:not(:disabled)": neutral.n700 } },
    paddingInline: space.s2_5,
    paddingBlock: space.s1_5,
    fontFamily: "inherit",
    // 16px under a finger: iOS zooms the page into a smaller focused field (see styles.css).
    fontSize: { default: text.xs, [env.touch]: text.base },
    color: ink.onDark,
    cursor: { default: "pointer", ":disabled": "not-allowed" },
    opacity: { default: 1, ":disabled": 0.4 },
  },
  stop: {
    marginTop: space.s2,
    width: "100%",
    borderWidth: 0,
    borderRadius: radii.control,
    backgroundColor: { default: "transparent", [env.hoverable]: { default: "transparent", ":hover": danger.d50 } },
    paddingInline: space.s3,
    paddingBlock: space.s2,
    textAlign: "start",
    fontFamily: "inherit",
    fontSize: text.xs,
    color: danger.d500,
  },
});

// One reusable context, created inside the click that starts the timer.
// Autoplay policy: a context created in a timer callback (no user activation)
// can start — and stay — "suspended", silently dropping the chime on Safari.
// A single long-lived context also stays clear of the per-page context cap.
let chimeAudioContext: AudioContext | null = null;

function unlockChimeAudioContext() {
  if (typeof window === "undefined") return;
  const AudioContextCtor =
    window.AudioContext ??
    (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor) return;
  chimeAudioContext ??= new AudioContextCtor();
  if (chimeAudioContext.state === "suspended") {
    void chimeAudioContext.resume().catch(() => {});
  }
}

/** The shared-countdown controls, embeddable outside the button's own popover. */
export function CountdownTimerPanel({
  countdown,
  onClose,
}: {
  countdown: SharedCountdownState;
  onClose?: () => void;
}) {
  const [customMinutes, setCustomMinutes] = useState("");

  const start = (minutes: number) => {
    if (!countdown.canControl || minutes <= 0) return;
    unlockChimeAudioContext();
    if (!countdown.start(minutes)) return;
    setCustomMinutes("");
    onClose?.();
  };

  const stop = () => {
    if (!countdown.stop()) return;
    onClose?.();
  };

  return (
    <div>
      <p {...stylex.props(styles.heading)}>Shared countdown</p>
      {countdown.active && (
        <p {...stylex.props(styles.readout)}>
          {formatClock(countdown.remainingSeconds)}
        </p>
      )}
      {!countdown.canControl && (
        <p {...stylex.props(styles.note)}>
          A host or moderator controls this timer for everyone.
        </p>
      )}
      {countdown.canControl && <><div {...stylex.props(styles.presets)}>
        {[5, 10, 15, 20, 25, 30].map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => start(m)}
            {...stylex.props(pressable.base, motion.tint, styles.preset)}
          >
            {m}m
          </button>
        ))}
      </div>
      <div {...stylex.props(row.x1, styles.customRow)}>
        <input
          type="number"
          min="1"
          max="999"
          value={customMinutes}
          onChange={(e) => setCustomMinutes(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              const m = parseInt(customMinutes, 10);
              if (!isNaN(m) && m > 0) start(m);
            }
          }}
          placeholder="Custom (min)"
          {...stylex.props(dockPopover.field, styles.customField)}
        />
        <button
          type="button"
          onClick={() => {
            const m = parseInt(customMinutes, 10);
            if (!isNaN(m) && m > 0) start(m);
          }}
          disabled={!customMinutes || parseInt(customMinutes, 10) <= 0}
          {...stylex.props(pressable.base, motion.tint, styles.startButton)}
        >
          Start
        </button>
      </div>
      {countdown.active && (
        <button
          type="button"
          onClick={stop}
          {...stylex.props(pressable.base, motion.tint, styles.stop)}
        >
          Stop countdown
        </button>
      )}</>}
    </div>
  );
}
