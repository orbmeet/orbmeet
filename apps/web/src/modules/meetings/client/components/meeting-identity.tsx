import { progress } from "@orbmeet/ui/styles/animations";
import { focus, layout, motion, pressable } from "@orbmeet/ui/styles/atoms";
import { accent, danger, ink, live, neutral, warning } from "@orbmeet/ui/tokens/colors.stylex";
import { bp, env } from "@orbmeet/ui/tokens/media.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { leading, text, tracking, weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";
import { Check, Link2, Lock, Monitor, Radio, SquarePen } from "lucide-react";
import { BrandMark } from "@orbmeet/ui/react";
import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";

const styles = stylex.create({
  /**
   * The leading half of the top bar: the room's name over one live line —
   * the clock, how many are here, and anything that changes what happens to
   * you (recording, live, locked). It truncates from the title inward rather
   * than growing a third line.
   */
  bar: { display: "flex", minWidth: 0, flexDirection: "column", justifyContent: "center", gap: 1 },
  name: { display: "flex", minWidth: 0, alignItems: "center", gap: space.s1_5 },
  title: {
    margin: 0,
    minWidth: 0,
    flexShrink: 1,
    fontSize: text.sm,
    lineHeight: leading.xs,
    fontWeight: weight.semibold,
    letterSpacing: tracking.tight,
    color: ink.strong,
  },
  /**
   * An untitled meeting is known by its code, and the code never truncates:
   * "vyf-fadu-gvw" collapsed to "V…" on a tablet's narrow bar, which hides the
   * one thing a code is for. Set in the bar's own face, like everything
   * beside it.
   */
  titleCode: { letterSpacing: tracking.normal, flexShrink: 0 },
  /** A named meeting's code, quieter, after its name: what someone types to join. */
  code: { flexShrink: 0, fontSize: text.xs2, fontWeight: weight.medium, color: neutral.n500 },
  /** The link, right beside the name it gets you into. */
  copy: {
    display: "inline-flex",
    height: 24,
    width: 24,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.field,
    color: { default: neutral.n500, [env.hoverable]: { default: neutral.n500, ":hover": ink.strong } },
    backgroundColor: { default: "transparent", [env.hoverable]: { default: "transparent", ":hover": neutral.n100 } },
  },
  copied: { color: accent.a600, backgroundColor: accent.a50 },

  status: {
    display: "flex",
    minWidth: 0,
    alignItems: "center",
    gap: space.s1_5,
    fontSize: text.xs,
    lineHeight: leading.xs,
    color: neutral.n500,
    whiteSpace: "nowrap",
  },
  liveDot: { width: 6, height: 6, flexShrink: 0, borderRadius: radii.pill, backgroundColor: live.l600 },
  /** The clock: tabular figures, so it does not jitter as it ticks, in the bar's own face. */
  elapsed: { fontVariantNumeric: "tabular-nums", color: neutral.n600 },
  fact: { display: "inline-flex", flexShrink: 0, alignItems: "center", gap: space.s1 },
  factSecondary: { display: { default: "none", [bp.lg]: "inline-flex" } },
  spaceName: { maxWidth: "14ch" },
  /**
   * Recording and streaming are red, and a locked room amber: the facts that
   * change what happens to you, or to whoever arrives next.
   */
  broadcasting: { fontWeight: weight.semibold, color: danger.d600 },
  locked: { fontWeight: weight.medium, color: warning.w800 },
  transcribing: { fontWeight: weight.medium, color: live.l700 },
  /** The word gives way on a narrow bar; the padlock stays. */
  lockedWord: { display: { default: "none", [bp.lg]: "inline" } },
  /** Likewise Orb's mark: a tablet in portrait clipped the word to "Transcrib". */
  transcribingWord: { display: { default: "none", [bp.lg]: "inline" } },
  recordingDot: { height: 6, width: 6, flexShrink: 0, borderRadius: radii.pill, backgroundColor: "currentColor" },
});
import type { MeetingClockSync } from "@/modules/meetings/client/meeting-clock";
import { useMeetingElapsedSeconds } from "@/modules/meetings/client/use-meeting-elapsed-seconds";
import { formatClock } from "@/modules/meetings/client/format-duration";

interface MeetingIdentityProps {
  code: string;
  meetingTitle?: string | null;
  spaceName?: string | null;
  meetingClock: MeetingClockSync;
  isRecording: boolean;
  isStreaming?: boolean;
  /** New people wait to be let in. Shown to everyone, not only to hosts. */
  isLocked?: boolean;
  /** What people say is being sent to Deepgram. Shown to everyone, since it is about them. */
  isTranscribing?: boolean;
  isScreenSharing?: boolean;
  surfaceActive?: boolean;
  surfaceLabel?: string;
  /** Egress/recorder renders: state only, nothing to click. */
  readOnly?: boolean;
  /** Copies the meeting link; the button sits beside the heading. */
  onCopyLink?: () => void;
  /** How many are here, the recorder aside. */
  peopleCount?: number;
}

/** How long the button shows its tick after a copy. */
const COPIED_MS = 1600;

function CopyLinkButton({ onCopy }: { onCopy: () => void }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);
  const handleClick = useCallback(() => {
    onCopy();
    setCopied(true);
  }, [onCopy]);
  return (
    <button
      type="button"
      onClick={handleClick}
      aria-label="Copy meeting link"
      title="Copy meeting link"
      {...stylex.props(pressable.base, motion.tint, focus.ring, styles.copy, copied && styles.copied)}
    >
      {copied ? <Check size={13} strokeWidth={2.25} /> : <Link2 size={13} strokeWidth={2} />}
    </button>
  );
}

/**
 * Who and what this Meeting is.
 *
 * It carries no controls: it is the leading half of the top bar, and the
 * controls take the trailing half. The name, then one line that reads as a
 * sentence — live for 24:18 · 8 people · Recording — rather than a row of
 * competing pills. The link is given right beside the name.
 */
export function MeetingIdentity({
  code,
  meetingTitle,
  spaceName,
  meetingClock,
  isRecording,
  isStreaming = false,
  isLocked = false,
  isTranscribing = false,
  isScreenSharing = false,
  surfaceActive = false,
  surfaceLabel = "Whiteboard",
  readOnly = false,
  onCopyLink,
  peopleCount,
}: MeetingIdentityProps) {
  const elapsed = useMeetingElapsedSeconds(meetingClock);
  const showCopy = onCopyLink !== undefined && !readOnly;

  // The heading is the most human name the meeting has: its own title, then
  // the Space it belongs to — "Algebra study group" says what this room is,
  // where "nzx-qoqq-wit" only says how to get in — and only then its code.
  const heading = meetingTitle || spaceName || code;
  const untitled = heading === code;

  // `secondary` facts give way first when the bar is narrow — a tablet in
  // portrait has the controls taking most of the line, and the title and the
  // clock are what the line is for.
  const factItems: { node: ReactNode; secondary?: boolean }[] = [];

  if (spaceName && spaceName !== heading) {
    factItems.push({
      secondary: true,
      node: (
        <span title={spaceName} {...stylex.props(styles.spaceName, layout.truncate)}>
          {spaceName}
        </span>
      ),
    });
  }

  if (peopleCount !== undefined) {
    factItems.push({ node: <span>{peopleCount === 1 ? "just you" : `${peopleCount} people`}</span> });
  }

  if (isRecording) {
    factItems.push({
      node: (
        <span {...stylex.props(styles.fact, styles.broadcasting)}>
          <span aria-hidden="true" {...stylex.props(styles.recordingDot, progress.pulse)} />
          Recording
        </span>
      ),
    });
  }

  if (isStreaming) {
    factItems.push({
      node: (
        <span {...stylex.props(styles.fact, styles.broadcasting)}>
          <Radio size={12} strokeWidth={2} />
          Live
        </span>
      ),
    });
  }

  if (isTranscribing) {
    factItems.push({
      node: (
        <span
          title="Transcribing: what people say is sent to Deepgram for captions, the transcript and the summary"
          {...stylex.props(styles.fact, styles.transcribing)}
        >
          {/* Orb's mark, listening: the same mark that turns when Orb is asked something. */}
          <BrandMark size={12} state="listening" />
          <span {...stylex.props(styles.transcribingWord)}>Transcribing</span>
        </span>
      ),
    });
  }

  if (isLocked) {
    factItems.push({
      node: (
        <span
          title="Locked: new people wait to be let in"
          {...stylex.props(styles.fact, styles.locked)}
        >
          <Lock size={11} strokeWidth={2.25} aria-hidden="true" />
          <span {...stylex.props(styles.lockedWord)}>Locked</span>
        </span>
      ),
    });
  }

  if (readOnly) {
    if (isScreenSharing) {
      factItems.push({
        node: (
          <span {...stylex.props(styles.fact)}>
            <Monitor size={12} strokeWidth={1.75} />
            Presenting
          </span>
        ),
      });
    }
    if (surfaceActive) {
      factItems.push({
        node: (
          <span {...stylex.props(styles.fact)}>
            <SquarePen size={12} strokeWidth={1.75} />
            {surfaceLabel}
          </span>
        ),
      });
    }
  }

  return (
    <div {...stylex.props(styles.bar)}>
      <div {...stylex.props(styles.name)}>
        <h1 {...stylex.props(styles.title, layout.truncate, untitled && styles.titleCode)} title={heading}>
          {heading}
        </h1>
        {!untitled && <span {...stylex.props(styles.code)}>{code}</span>}
        {showCopy && <CopyLinkButton onCopy={onCopyLink} />}
      </div>
      <div {...stylex.props(styles.status)}>
        <span aria-hidden="true" {...stylex.props(styles.liveDot)} />
        <span {...stylex.props(styles.elapsed)}>{formatClock(elapsed)}</span>
        {factItems.map((item, index) => (
          <span key={index} {...stylex.props(styles.fact, item.secondary && styles.factSecondary)}>
            <span aria-hidden="true">·</span>
            {item.node}
          </span>
        ))}
      </div>
    </div>
  );
}
