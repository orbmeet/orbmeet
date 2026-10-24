import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { leading, text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import { warning } from "@orbmeet/ui/tokens/colors.stylex";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";

import { formatClock } from "@/modules/meetings/client/format-duration";
import type { SharedCountdownState } from "@/modules/meetings/client/use-shared-countdown";

const RING_RADIUS = 7;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

const styles = stylex.create({
  chip: {
    display: "inline-flex",
    flexShrink: 0,
    alignItems: "center",
    gap: space.s1_5,
    height: 28,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: warning.w200,
    backgroundColor: warning.w100,
    paddingInlineStart: space.s1_5,
    paddingInlineEnd: space.s2_5,
    fontSize: text.xs,
    lineHeight: leading.xs,
    fontWeight: weight.semibold,
    color: warning.w800,
    whiteSpace: "nowrap",
  },
  compact: { height: 24, paddingInlineEnd: space.s2, fontSize: text.xs2 },
  clock: { fontVariantNumeric: "tabular-nums", fontWeight: weight.bold },
  ring: { flexShrink: 0, transform: "rotate(-90deg)" },
  track: { stroke: warning.w200 },
  progress: { stroke: warning.w500, transitionProperty: "stroke-dashoffset", transitionDuration: "1s" },
});

/**
 * The shared countdown, where everyone in the room can see it.
 *
 * A host could start a countdown for the whole room, and nobody could see it:
 * its only readout was inside the host's own More panel. The clock now sits
 * in the meeting's bar on every device while it runs, and says so once it has
 * run out, so "two minutes left" is something the room shares rather than
 * something one person announces.
 *
 * `role="timer"` is deliberately not a live region: a clock that announced
 * every second would talk over the meeting.
 */
export function SharedTimerChip({
  countdown,
  compact = false,
}: {
  countdown: Pick<SharedCountdownState, "active" | "done" | "remainingSeconds" | "endsAtMs">;
  compact?: boolean;
}) {
  // The ring drains from however long the countdown had when this device first
  // saw it — the length it was started with, unless you joined part-way.
  // The largest remaining time seen for this countdown: the first render after
  // a start can arrive before the first tick has filled the clock in.
  const [seen, setSeen] = useState({ endsAtMs: countdown.endsAtMs, total: countdown.remainingSeconds });
  if (seen.endsAtMs !== countdown.endsAtMs || countdown.remainingSeconds > seen.total) {
    setSeen({
      endsAtMs: countdown.endsAtMs,
      total: seen.endsAtMs === countdown.endsAtMs ? Math.max(seen.total, countdown.remainingSeconds) : countdown.remainingSeconds,
    });
  }
  if (!countdown.active && !countdown.done) return null;
  const remaining = Math.max(0, countdown.remainingSeconds);
  const total = Math.max(seen.endsAtMs === countdown.endsAtMs ? seen.total : 0, countdown.remainingSeconds);
  const fraction = total > 0 ? Math.min(1, remaining / total) : 0;
  const label = countdown.done ? "Time’s up" : formatClock(remaining);
  return (
    <span
      role="timer"
      aria-label={countdown.done ? "Shared timer: time’s up" : `Shared timer: ${label} left`}
      {...stylex.props(styles.chip, compact && styles.compact)}
    >
      <svg width={16} height={16} viewBox="0 0 18 18" aria-hidden="true" {...stylex.props(styles.ring)}>
        <circle cx={9} cy={9} r={RING_RADIUS} fill="none" strokeWidth={3} {...stylex.props(styles.track)} />
        <circle
          cx={9}
          cy={9}
          r={RING_RADIUS}
          fill="none"
          strokeWidth={3}
          strokeLinecap="round"
          strokeDasharray={RING_CIRCUMFERENCE}
          strokeDashoffset={RING_CIRCUMFERENCE * (1 - fraction)}
          {...stylex.props(styles.progress)}
        />
      </svg>
      {!compact && !countdown.done && <span>Timer</span>}
      <span {...stylex.props(styles.clock)}>{label}</span>
    </span>
  );
}
