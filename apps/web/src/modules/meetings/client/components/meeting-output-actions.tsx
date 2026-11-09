import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { openExternalUrl, useToast } from "@orbmeet/ui/react";
import { focus, motion } from "@orbmeet/ui/styles/atoms";
import { accent, border, ink, neutral } from "@orbmeet/ui/tokens/colors.stylex";
import { env } from "@orbmeet/ui/tokens/media.stylex";
import { text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import * as stylex from "@stylexjs/stylex";
import { getErrorMessage } from "@/lib/error-inspection";
import { getWhiteboardPdfDownloadUrl } from "@/modules/whiteboards/server/export.functions";

/** What a past meeting left behind, as far as a list of meetings knows. */
export interface MeetingOutputs {
  meetingId: string;
  hasWhiteboard: boolean;
  /** The PDF has been made already, so a press can download it straight away. */
  hasWhiteboardPdf: boolean;
  hasRecording: boolean;
  /** A summary is only ever written from a transcript, so it stands for one here. */
  hasSummary: boolean;
}

const styles = stylex.create({
  // Fixed columns, so PDF, Recording and Transcript line up down a list even
  // when a meeting has only some of them.
  group: { display: "grid", gridTemplateColumns: "56px 92px 92px", columnGap: space.s1_5, flexShrink: 0 },
  action: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    boxSizing: "border-box",
    height: { default: 36, [env.touch]: 44 },
    borderRadius: 10,
    cursor: "pointer",
    fontFamily: "inherit",
    fontSize: "0.84375rem",
    fontWeight: weight.medium,
    textDecorationLine: "none",
  },
  pdf: {
    gridColumnStart: 1,
    borderWidth: 0,
    fontWeight: weight.semibold,
    color: accent.a700,
    backgroundColor: { default: accent.a100, [env.hoverable]: { default: accent.a100, ":hover": accent.a200 } },
    opacity: { default: 1, ":disabled": 0.6 },
    fontSize: text.sm,
  },
  outline: {
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: border.base,
    color: ink.strong,
    backgroundColor: { default: "transparent", [env.hoverable]: { default: "transparent", ":hover": neutral.n100 } },
  },
  recording: { gridColumnStart: 2 },
  transcript: { gridColumnStart: 3 },
});

/**
 * The three things people come back to a meeting for, right on its row. A
 * button only appears when there is something behind it.
 */
export function MeetingOutputActions({ meeting, title, fromSpace }: { meeting: MeetingOutputs; title: string; fromSpace?: string }) {
  const [opening, setOpening] = useState(false);
  const { add: addToast } = useToast();
  const openPage = (view: "pdf" | "recording" | "transcript") =>
    ({ to: "/meetings/$meetingId", params: { meetingId: meeting.meetingId }, search: { fromSpace, view } }) as const;

  const downloadPdf = () => {
    setOpening(true);
    getWhiteboardPdfDownloadUrl({ data: { meetingId: meeting.meetingId } })
      .then(({ downloadUrl }) => openExternalUrl(downloadUrl))
      .catch((error: unknown) => {
        addToast({
          title: "The PDF couldn’t be opened",
          description: getErrorMessage(error, "Try again in a moment."),
          data: { variant: "error" },
        });
      })
      .finally(() => setOpening(false));
  };

  if (!meeting.hasWhiteboard && !meeting.hasRecording && !meeting.hasSummary) return null;

  return (
    <span {...stylex.props(styles.group)}>
      {meeting.hasWhiteboardPdf ? (
        <button
          type="button"
          aria-label={`Download PDF of ${title}`}
          disabled={opening}
          onClick={downloadPdf}
          {...stylex.props(styles.action, styles.pdf, motion.tint, focus.ring)}
        >
          PDF
        </button>
      ) : meeting.hasWhiteboard ? (
        // Not made yet: the meeting's page is where the browser builds it.
        <Link {...openPage("pdf")} aria-label={`Get PDF of ${title}`} {...stylex.props(styles.action, styles.pdf, motion.tint, focus.ring)}>
          PDF
        </Link>
      ) : null}
      {meeting.hasRecording ? (
        <Link {...openPage("recording")} aria-label={`Recording of ${title}`} {...stylex.props(styles.action, styles.outline, styles.recording, motion.tint, focus.ring)}>
          Recording
        </Link>
      ) : null}
      {meeting.hasSummary ? (
        <Link {...openPage("transcript")} aria-label={`Transcript of ${title}`} {...stylex.props(styles.action, styles.outline, styles.transcript, motion.tint, focus.ring)}>
          Transcript
        </Link>
      ) : null}
    </span>
  );
}
