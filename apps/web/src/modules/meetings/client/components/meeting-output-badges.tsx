import * as stylex from "@stylexjs/stylex";
import type { StyleXStyles } from "@stylexjs/stylex";
import { CheckSquare, Sparkles, Video } from "lucide-react";

import { focus, motion } from "@orbmeet/ui/styles/atoms";
import { accent, record, violet } from "@orbmeet/ui/tokens/colors.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { text, weight } from "@orbmeet/ui/tokens/typography.stylex";

/**
 * Saved Meeting outputs.
 *
 * Colour-coding stays consistent wherever they appear:
 *   Summary    → violet (the AI accent)
 *   Recording  → rose   (media)
 *   Whiteboard → accent
 *
 * Transcript is implied by Summary, so it has no separate pill.
 */
interface MeetingOutputFlags {
  hasSummary?: boolean;
  hasRecording?: boolean;
  hasWhiteboardPdf?: boolean;
  hasWhiteboardState?: boolean;
}

const styles = stylex.create({
  group: { display: "inline-flex", flexWrap: "wrap", alignItems: "center", gap: space.s1_5 },
  pill: {
    display: "inline-flex",
    whiteSpace: "nowrap",
    alignItems: "center",
    borderRadius: radii.pill,
    fontWeight: weight.medium,
    textDecorationLine: "none",
  },
  /** A badge that links to its section of the Meeting page sits above a row link. */
  linked: { position: "relative", zIndex: 1 },
  sm: { paddingInline: space.s1_5, paddingBlock: space.s0_5, fontSize: text.xs2, gap: space.s1 },
  md: { paddingInline: space.s2, paddingBlock: space.s0_5, fontSize: "0.6875rem", gap: space.s1 },

  summary: { backgroundColor: violet.v50, color: violet.v700 },
  /**
   * Rose, and only here. Recording is the one output that is also a state a
   * person is *in* while it is happening, so it borrows the colour the record
   * indicator uses rather than any of the semantic scales.
   */
  recording: { backgroundColor: record.r50, color: record.r700 },
  whiteboard: { backgroundColor: accent.a50, color: accent.a700 },
});

const sizes = { sm: styles.sm, md: styles.md } as const;
const iconSize = { sm: 9, md: 11 } as const;

export type MeetingOutputKind = "summary" | "recording" | "whiteboard";

interface MeetingOutputBadgesProps extends MeetingOutputFlags {
  sx?: StyleXStyles;
  size?: keyof typeof sizes;
  /** When given, each badge links to that output — its section on the Meeting page. */
  hrefFor?: (kind: MeetingOutputKind) => string;
}

export function MeetingOutputBadges({
  hasSummary,
  hasRecording,
  hasWhiteboardPdf,
  hasWhiteboardState,
  sx,
  size = "sm",
  hrefFor,
}: MeetingOutputBadgesProps) {
  const hasBoard = hasWhiteboardPdf || hasWhiteboardState;
  if (!hasSummary && !hasRecording && !hasBoard) return null;

  const badge = (kind: MeetingOutputKind, tone: StyleXStyles, Icon: typeof Sparkles, label: string) => {
    const content = (
      <>
        <Icon size={iconSize[size]} aria-hidden />
        {label}
      </>
    );
    return hrefFor ? (
      <a
        key={kind}
        href={hrefFor(kind)}
        aria-label={`Open ${kind}`}
        {...stylex.props(styles.pill, sizes[size], tone, styles.linked, focus.ring, motion.tint)}
      >
        {content}
      </a>
    ) : (
      <span key={kind} {...stylex.props(styles.pill, sizes[size], tone)}>{content}</span>
    );
  };

  return (
    <span {...stylex.props(styles.group, sx)}>
      {hasSummary && badge("summary", styles.summary, Sparkles, "Summary")}
      {hasRecording && badge("recording", styles.recording, Video, "Recording")}
      {hasBoard && badge("whiteboard", styles.whiteboard, CheckSquare, "Whiteboard")}
    </span>
  );
}
