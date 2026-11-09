import type { ReactNode } from "react";
import { DotList } from "@orbmeet/ui/react";
import { focus, layout, motion } from "@orbmeet/ui/styles/atoms";
import { ink, neutral, surface } from "@orbmeet/ui/tokens/colors.stylex";
import { bp, env } from "@orbmeet/ui/tokens/media.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { fonts, text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";
import { Link } from "@tanstack/react-router";
import { Presentation, Video } from "lucide-react";

import { MeetingBoardPreview } from "./meeting-board-preview";
import { MeetingOutputActions } from "./meeting-output-actions";
import { formatMeetingLength, formatTimeRange, meetingDisplayTitle } from "./meeting-format";

/** What a row needs to know about a past meeting; every meeting list has it. */
export interface MeetingRowData {
  meetingId: string;
  title: string | null;
  startedAt: string | null;
  endedAt: string | null;
  spaceName: string | null;
  participantNames: readonly string[];
  hasSummary: boolean;
  hasWhiteboard: boolean;
  hasWhiteboardPdf: boolean;
  hasRecording: boolean;
}

/** Under this long, a call is usually someone testing their mic. */
const SHORT_CALL_MS = 5 * 60_000;

export function isShortCall(meeting: { startedAt: string | null; endedAt: string | null }): boolean {
  if (!meeting.startedAt || !meeting.endedAt) return false;
  return Date.parse(meeting.endedAt) - Date.parse(meeting.startedAt) < SHORT_CALL_MS;
}

const styles = stylex.create({
  row: {
    position: "relative",
    display: "flex",
    flexWrap: { default: "wrap", [bp.md]: "nowrap" },
    alignItems: "center",
    columnGap: { default: space.s3, [bp.sm]: space.s4 },
    rowGap: space.s2,
    paddingBlock: space.s2_5,
    paddingInline: space.s3,
    marginInline: `calc(-1 * ${space.s3})`,
    borderRadius: 14,
    color: ink.strong,
    backgroundColor: { default: "transparent", [env.hoverable]: { default: "transparent", ":hover": neutral.n50 } },
  },
  // The whole row opens the meeting; the buttons sit above this link.
  open: { position: "absolute", inset: 0, zIndex: 0, borderRadius: 14 },
  thumb: {
    display: "grid",
    placeItems: "center",
    flexShrink: 0,
    width: { default: 64, [bp.sm]: 88 },
    height: { default: 44, [bp.sm]: 56 },
    borderRadius: 10,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: neutral.n150,
    backgroundColor: surface.sunken,
    color: neutral.n400,
    overflow: "hidden",
  },
  body: { display: "flex", flexDirection: "column", gap: 3, flexGrow: 1, flexBasis: 200, minWidth: 0 },
  title: { fontSize: text.base, fontWeight: weight.medium, lineHeight: 1.3 },
  meta: { fontSize: "0.8125rem", color: ink.muted },
  time: { fontFamily: fonts.mono, fontSize: "0.78125rem" },
  actions: { position: "relative", zIndex: 1 },
});

/**
 * One past meeting, the same shape everywhere it is listed — Home, the
 * Library, a Space: what it was, when and how long, and the buttons for what
 * it left behind.
 */
export function MeetingRow({
  meeting,
  viewerName,
  renderTitle,
  fromSpace,
}: {
  meeting: MeetingRowData;
  viewerName?: string;
  /** The title as drawn, for a search to mark what matched. */
  renderTitle?: (title: string) => ReactNode;
  /** Where "back" from the meeting goes, when listed inside a Space. */
  fromSpace?: string;
}) {
  const title = meetingDisplayTitle(meeting.title, meeting.participantNames, viewerName);
  const length = formatMeetingLength(meeting.startedAt, meeting.endedAt);

  return (
    <div {...stylex.props(styles.row, motion.tint)}>
      <Link
        to="/meetings/$meetingId"
        params={{ meetingId: meeting.meetingId }}
        search={{ fromSpace }}
        aria-label={`Open ${title}`}
        {...stylex.props(styles.open, focus.ring)}
      />
      <span {...stylex.props(styles.thumb)} aria-hidden="true">
        {meeting.hasWhiteboard ? (
          <MeetingBoardPreview meetingId={meeting.meetingId} fallback={<Presentation size={22} strokeWidth={1.5} />} />
        ) : (
          <Video size={22} strokeWidth={1.5} />
        )}
      </span>
      <span {...stylex.props(styles.body)}>
        <span {...stylex.props(styles.title, layout.truncate)}>{renderTitle ? renderTitle(title) : title}</span>
        <DotList sx={styles.meta}>
          {meeting.startedAt ? (
            <span {...stylex.props(styles.time)}>{formatTimeRange(meeting.startedAt, meeting.endedAt)}</span>
          ) : null}
          {length ? <span>{length}</span> : null}
          <span>{meeting.spaceName ?? "Personal"}</span>
        </DotList>
      </span>
      <span {...stylex.props(styles.actions)}>
        <MeetingOutputActions meeting={meeting} title={title} fromSpace={fromSpace} />
      </span>
    </div>
  );
}

export interface MeetingDay<T> {
  key: string;
  /** "Today", "Yesterday", or the weekday. */
  label: string;
  /** "Oct 15" — set in the mono face beside the label. */
  date: string;
  meetings: T[];
}

/** Meetings by the calendar day they started on, newest day first, in the order given within a day. */
export function groupMeetingsByDay<T extends { startedAt: string | null }>(meetings: readonly T[], now = new Date()): MeetingDay<T>[] {
  const days = new Map<string, MeetingDay<T>>();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  for (const meeting of meetings) {
    if (!meeting.startedAt) continue;
    const at = new Date(meeting.startedAt);
    const day = new Date(at.getFullYear(), at.getMonth(), at.getDate());
    const key = day.toDateString();
    let group = days.get(key);
    if (!group) {
      const label =
        key === today.toDateString()
          ? "Today"
          : key === yesterday.toDateString()
            ? "Yesterday"
            : day.toLocaleDateString([], { weekday: "long" });
      const sameYear = day.getFullYear() === today.getFullYear();
      group = {
        key,
        label,
        date: day.toLocaleDateString([], { month: "short", day: "numeric", year: sameYear ? undefined : "numeric" }),
        meetings: [],
      };
      days.set(key, group);
    }
    group.meetings.push(meeting);
  }
  return [...days.values()];
}
