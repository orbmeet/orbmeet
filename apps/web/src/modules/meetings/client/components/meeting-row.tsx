import { Avatar, DotList } from "@orbmeet/ui/react";
import { focus, layout, motion } from "@orbmeet/ui/styles/atoms";
import { accent, ink, neutral, surface } from "@orbmeet/ui/tokens/colors.stylex";
import { bp, env } from "@orbmeet/ui/tokens/media.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { fonts, text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";
import { Link } from "@tanstack/react-router";
import { Play, Presentation, Sparkles, Video } from "lucide-react";

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
  hasRecording: boolean;
}

/** People shown as faces before the rest are left to the title. */
const FACES = 3;

const styles = stylex.create({
  row: {
    display: "flex",
    alignItems: "center",
    gap: { default: space.s3, [bp.sm]: space.s4 },
    paddingBlock: space.s2_5,
    paddingInline: space.s3,
    marginInline: `calc(-1 * ${space.s3})`,
    borderRadius: 14,
    color: ink.strong,
    textDecorationLine: "none",
    backgroundColor: { default: "transparent", [env.hoverable]: { default: "transparent", ":hover": neutral.n50 } },
  },
  thumb: {
    display: "grid",
    placeItems: "center",
    flexShrink: 0,
    width: { default: 64, [bp.sm]: 112 },
    height: { default: 44, [bp.sm]: 70 },
    borderRadius: 10,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: neutral.n150,
    backgroundColor: surface.sunken,
    color: neutral.n400,
  },
  body: { display: "flex", flexDirection: "column", gap: 5, flexGrow: 1, minWidth: 0 },
  title: { fontSize: text.base, fontWeight: weight.medium, lineHeight: 1.3 },
  meta: { fontSize: "0.8125rem", color: ink.muted },
  time: { fontFamily: fonts.mono, fontSize: "0.78125rem" },
  trail: { display: "flex", alignItems: "center", gap: space.s3_5, flexShrink: 0 },
  outputs: { display: "flex", gap: space.s1_5 },
  output: {
    display: "grid",
    placeItems: "center",
    width: 26,
    height: 26,
    borderRadius: 7,
    backgroundColor: neutral.n100,
    color: neutral.n600,
  },
  summary: { backgroundColor: accent.a100, color: accent.a700 },
  faces: { display: { default: "none", [bp.sm]: "flex" }, paddingInlineStart: 3 },
  // A light overlap: at -6 the next face's ring hid the end of two-letter initials.
  face: { marginInlineStart: -3, fontWeight: weight.semibold, boxShadow: `0 0 0 2px ${surface.raised}` },
});

function Outputs({ meeting }: { meeting: MeetingRowData }) {
  const items = [
    meeting.hasSummary && { key: "summary", label: "Summary", icon: Sparkles, sx: styles.summary },
    meeting.hasWhiteboard && { key: "board", label: "Board", icon: Presentation, sx: null },
    meeting.hasRecording && { key: "recording", label: "Recording", icon: Play, sx: null },
  ].filter((item) => item !== false);
  if (items.length === 0) return null;
  return (
    <span {...stylex.props(styles.outputs)}>
      {items.map(({ key, label, icon: Icon, sx }) => (
        <span key={key} title={label} {...stylex.props(styles.output, sx)}>
          <Icon size={14} strokeWidth={1.9} aria-hidden="true" />
        </span>
      ))}
    </span>
  );
}

/**
 * One past meeting, the same shape everywhere it is listed — Home, the
 * Library, a Space: what the board looked like, what it was called, when and
 * how long, where, what came out of it, and who was there.
 */
export function MeetingRow({ meeting, viewerName }: { meeting: MeetingRowData; viewerName?: string }) {
  const title = meetingDisplayTitle(meeting.title, meeting.participantNames, viewerName);
  const length = formatMeetingLength(meeting.startedAt, meeting.endedAt);
  const outputs = [meeting.hasSummary && "summary", meeting.hasWhiteboard && "board", meeting.hasRecording && "recording"]
    .filter(Boolean)
    .join(", ");
  const people = meeting.participantNames;
  // Faces are for who else was there: you were, in every row.
  const faces = people.filter((name) => name !== viewerName);

  return (
    <Link
      to="/meetings/$meetingId"
      params={{ meetingId: meeting.meetingId }}
      {...stylex.props(styles.row, motion.tint, focus.ring)}
    >
      <span {...stylex.props(styles.thumb)} aria-hidden="true">
        {meeting.hasWhiteboard ? <Presentation size={22} strokeWidth={1.5} /> : <Video size={22} strokeWidth={1.5} />}
      </span>
      <span {...stylex.props(styles.body)}>
        <span {...stylex.props(styles.title, layout.truncate)}>{title}</span>
        <DotList sx={styles.meta}>
          {meeting.startedAt ? (
            <span {...stylex.props(styles.time)}>{formatTimeRange(meeting.startedAt, meeting.endedAt)}</span>
          ) : null}
          {length ? <span>{length}</span> : null}
          <span>{meeting.spaceName ?? "Personal"}</span>
        </DotList>
        {outputs ? <span {...stylex.props(layout.srOnly)}>Has {outputs}.</span> : null}
        {people.length > 0 ? <span {...stylex.props(layout.srOnly)}>With {people.join(", ")}.</span> : null}
      </span>
      <span {...stylex.props(styles.trail)}>
        <Outputs meeting={meeting} />
        {faces.length > 0 ? (
          <span {...stylex.props(styles.faces)} aria-hidden="true">
            {faces.slice(0, FACES).map((name) => (
              <Avatar key={name} name={name} sizePx={26} sx={styles.face} />
            ))}
          </span>
        ) : null}
      </span>
    </Link>
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
