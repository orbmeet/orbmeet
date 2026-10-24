import { progress } from "@orbmeet/ui/styles/animations";
import { layout, motion, pressable } from "@orbmeet/ui/styles/atoms";
import { danger, ink, live, neutral, surface } from "@orbmeet/ui/tokens/colors.stylex";
import { env } from "@orbmeet/ui/tokens/media.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import { scrim } from "@orbmeet/ui/tokens/wash.stylex";
import * as stylex from "@stylexjs/stylex";
import { LogOut } from "lucide-react";
import * as React from "react";

import type { PhoneStageModes } from "@/modules/meetings/client/components/dock-controls";
import { CHROME_GAP_PX, PHONE_HEADER_HEIGHT_PX, PHONE_MODE_SWITCH_HEIGHT_PX } from "@/modules/meetings/client/chrome";
import { formatClock } from "@/modules/meetings/client/format-duration";
import type { MeetingClockSync } from "@/modules/meetings/client/meeting-clock";
import { useMeetingElapsedSeconds } from "@/modules/meetings/client/use-meeting-elapsed-seconds";

const styles = stylex.create({
  /**
   * No safe-area maths here — `MeetingShell` mounts this inside the safe frame
   * and reserves this height in the stage rect for everything below it. The
   * height comes from the shared constant rather than a literal so the space
   * the header occupies and the space reserved for it cannot drift apart —
   * hence a dynamic style: StyleX cannot read a plain JS import at build time,
   * and duplicating the number here is exactly the drift this guards against.
   */
  band: (height: number) => ({ height, display: "flex", flexDirection: "column" }),
  /**
   * The gap above the card and at its sides: the header floats on the canvas
   * like the dock at the bottom, rather than standing as a band across it.
   * Dynamic for the same reason as `band`: the gap is the shared constant the
   * stage reserves, which StyleX cannot read at build time.
   */
  frame: (gap: number) => ({ paddingTop: gap, paddingInline: space.s3 }),
  /** The same white card as the dock: one outline, one lift. */
  card: {
    boxSizing: "border-box",
    overflow: "hidden",
    borderRadius: radii.panel,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: neutral.n150,
    backgroundColor: surface.raised,
    boxShadow: `0 12px 32px -12px ${scrim.soft}`,
  },
  rowHeight: (height: number) => ({ height }),
  row: {
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    gap: space.s0_5,
    paddingInline: space.s3,
  },
  identity: { display: "flex", minWidth: 0, flexDirection: "column" },
  title: { fontSize: text.sm, fontWeight: weight.semibold, color: ink.strong },
  status: { display: "flex", alignItems: "center", gap: space.s1, fontSize: text.xs2, color: neutral.n500 },
  transcribing: { display: "inline-flex", alignItems: "center", gap: space.s1 },
  transcribingWord: { fontWeight: weight.semibold, color: live.l700 },
  liveDot: { width: 6, height: 6, flexShrink: 0, borderRadius: radii.pill, backgroundColor: live.l600 },

  /** Talk | Board: which the stage shows, as one segmented control under the header. */
  modes: {
    display: "grid",
    flexShrink: 0,
    gap: 2,
    marginInline: space.s3,
    marginBottom: space.s2,
    borderRadius: radii.control,
    backgroundColor: neutral.n100,
    padding: 3,
  },
  modeColumns: (count: number) => ({ gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))` }),
  mode: {
    display: "grid",
    minWidth: 0,
    placeItems: "center",
    borderWidth: 0,
    borderRadius: radii.field,
    backgroundColor: "transparent",
    fontFamily: "inherit",
    fontSize: text.xs,
    fontWeight: weight.medium,
    color: neutral.n600,
    cursor: "pointer",
  },
  modeOn: {
    backgroundColor: surface.raised,
    fontWeight: weight.semibold,
    color: ink.strong,
    boxShadow: `0 1px 2px color-mix(in oklab, ${neutral.n900} 8%, transparent)`,
  },
  // Tabular figures: the clock ticks once a second and must not shuffle the
  // rest of the row sideways as digits change width.
  elapsed: { flexShrink: 0, fontVariantNumeric: "tabular-nums", color: neutral.n500 },
  liveTab: { width: 6, height: 6, flexShrink: 0, borderRadius: radii.pill, backgroundColor: danger.d500 },
  rec: {
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    gap: space.s1,
    borderRadius: radii.pill,
    backgroundColor: danger.d500,
    paddingInline: space.s1_5,
    paddingBlock: space.s0_5,
    fontSize: text.xs2,
    fontWeight: weight.semibold,
    color: ink.onDark,
  },
  recDot: { height: 6, width: 6, borderRadius: radii.pill, backgroundColor: ink.onDark },

  trailing: {
    marginInlineStart: "auto",
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    gap: space.s0_5,
  },
  /**
   * The way out, at the top: the bottom of a phone is where the thumb rests,
   * and a red button there was one stray tap from ending someone's call.
   */
  leave: {
    display: "flex",
    height: 36,
    alignItems: "center",
    gap: space.s1,
    marginInlineStart: space.s1,
    borderWidth: 0,
    borderRadius: radii.control,
    backgroundColor: { default: danger.d600, [env.hoverable]: { default: danger.d600, ":hover": danger.d700 } },
    paddingInline: space.s2_5,
    fontFamily: "inherit",
    fontSize: text.xs,
    fontWeight: weight.semibold,
    color: ink.onDark,
    cursor: "pointer",
    outlineStyle: "none",
    boxShadow: { default: "none", ":focus-visible": `0 0 0 2px color-mix(in oklab, ${danger.d500} 35%, transparent)` },
  },
  modeTab: { display: "inline-flex", alignItems: "center", gap: space.s1_5 },
});

interface MeetingPhoneHeaderProps {
  code: string;
  /** The meeting's name; the code stands in for a meeting without one. */
  title?: string | null;
  modes?: PhoneStageModes;
  meetingClock: MeetingClockSync;
  isRecording: boolean;
  /** What people say is being sent to Deepgram. */
  isTranscribing?: boolean;
  participantCount: number;
  /** Leave, or for a host the choice between leaving and ending the meeting. */
  onLeave: () => void;
  /** The room's shared countdown, while one runs: everyone's to see, not the host's alone. */
  timer?: React.ReactNode;
}

/**
 * The phone's top bar: the room's name over one live line — the clock and how
 * many are here — with the way out at its end, and under it what the stage shows. The head count is said once,
 * in words; People and the room's lock are a tab of the chat sheet, from the
 * dock.
 *
 * It is light, like every other surface in the room — the phone used to be the
 * one dark room in a light product, so a call moved between two visual
 * languages with the device. Rendered into the reserved top band, so it never
 * overlaps the video or the board below it.
 */
export function MeetingPhoneHeader({
  code,
  title,
  modes,
  meetingClock,
  isRecording,
  isTranscribing = false,
  participantCount,
  onLeave,
  timer,
}: MeetingPhoneHeaderProps) {
  const elapsed = useMeetingElapsedSeconds(meetingClock);
  const tabs = modes
    ? [
        { id: "talk" as const, label: "Talk", onSelect: modes.onTalk },
        ...(modes.onBoard ? [{ id: "board" as const, label: modes.boardLabel ?? "Board", onSelect: modes.onBoard }] : []),
        ...(modes.onScreen ? [{ id: "screen" as const, label: "Screen", onSelect: modes.onScreen }] : []),
      ]
    : [];

  return (
    <div {...stylex.props(styles.frame(CHROME_GAP_PX))}>
      <div
        {...stylex.props(
          styles.band(PHONE_HEADER_HEIGHT_PX + (modes ? PHONE_MODE_SWITCH_HEIGHT_PX : 0)),
          styles.card,
        )}
      >
        <div {...stylex.props(styles.row, styles.rowHeight(PHONE_HEADER_HEIGHT_PX), motion.tint)}>
          <span {...stylex.props(styles.identity)}>
            <span {...stylex.props(styles.title, layout.truncate)}>{title || code}</span>
            <span {...stylex.props(styles.status)}>
              <span aria-hidden="true" {...stylex.props(styles.liveDot)} />
              <span {...stylex.props(styles.elapsed)}>{formatClock(elapsed)}</span>
              <span>· {participantCount === 1 ? "just you" : `${participantCount} people`}</span>
              {/* In words: a bare captions glyph after the dot read as a
                  stray icon, not as "what you say is being sent". */}
              {isTranscribing && (
                <span
                  title="Transcribing: what people say is sent to Deepgram for captions, the transcript and the summary"
                  {...stylex.props(styles.transcribing)}
                >
                  · <span {...stylex.props(styles.transcribingWord)}>Transcribing</span>
                </span>
              )}
            </span>
          </span>
          {isRecording && (
            <span {...stylex.props(styles.rec)}>
              <span {...stylex.props(styles.recDot, progress.pulse)} />
              REC
            </span>
          )}
          {timer}
          <span {...stylex.props(styles.trailing)}>
            <button
              type="button"
              onClick={onLeave}
              aria-label="Leave meeting"
              {...stylex.props(pressable.base, motion.tint, styles.leave)}
            >
              <LogOut size={15} strokeWidth={2} aria-hidden="true" />
              Leave
            </button>
          </span>
        </div>
        {modes && (
          <div
            role="tablist"
            aria-label="What the stage shows"
            {...stylex.props(styles.modes, styles.modeColumns(tabs.length), styles.rowHeight(PHONE_MODE_SWITCH_HEIGHT_PX - 8))}
          >
            {tabs.map((tab) => {
              const selected = modes.shown === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  onClick={selected ? undefined : tab.onSelect}
                  {...stylex.props(pressable.base, motion.tint, styles.mode, selected && styles.modeOn, layout.truncate)}
                >
                  <span {...stylex.props(styles.modeTab)}>
                    {tab.id === "screen" && <span aria-hidden="true" {...stylex.props(styles.liveTab)} />}
                    {tab.label}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
