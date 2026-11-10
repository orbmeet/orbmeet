import { useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useInfiniteQuery, useSuspenseInfiniteQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import * as stylex from "@stylexjs/stylex";
import { homeRecentMeetingsQueryOptions, myUpcomingMeetingSchedulesQueryOptions } from "@/app/query-client/queries/meetings";
import { meetingDisplayTitle } from "@/modules/meetings/client/components/meeting-format";
import { beginMeetingEntryFlow } from "@/modules/meetings/client/entry-metrics";
import { ScheduleMeetingDialog } from "@/modules/scheduling/client/schedule-meeting-dialog";
import type { Thread } from "@/modules/meetings/contract/threads";
import { enter } from "@orbmeet/ui/styles/animations";
import { focus, layout, motion, touch } from "@orbmeet/ui/styles/atoms";
import { accent, border, ink, live, neutral, surface } from "@orbmeet/ui/tokens/colors.stylex";
import { bp, env } from "@orbmeet/ui/tokens/media.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { text, weight } from "@orbmeet/ui/tokens/typography.stylex";

/** How many scheduled meetings Home lists before the Calendar takes over. */
const UPCOMING_LIMIT = 3;

const styles = stylex.create({
  // A section of the page, not a box: the page is the frame.
  section: { display: "flex", flexDirection: "column", gap: space.s3 },
  head: { display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: space.s3 },
  heading: { margin: 0, fontSize: "0.9375rem", fontWeight: weight.semibold, color: ink.strong },
  headActions: { display: "flex", alignItems: "center", gap: space.s4 },
  headLink: { fontSize: "0.8125rem", fontWeight: weight.medium, color: accent.a700, textDecorationLine: "none" },
  list: {
    margin: 0,
    padding: 0,
    listStyle: "none",
    display: "flex",
    flexDirection: "column",
    borderRadius: 16,
    boxShadow: `0 0 0 1px ${border.subtle}`,
    backgroundColor: surface.raised,
  },
  row: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: space.s4,
    rowGap: space.s2,
    paddingBlock: space.s3,
    paddingInline: space.s5,
    borderBottomWidth: { default: 1, ":last-child": 0 },
    borderBottomStyle: "solid",
    borderBottomColor: border.subtle,
  },
  when: { flexShrink: 0, width: { default: "100%", [bp.sm]: 168 }, fontSize: text.sm, fontWeight: weight.semibold, color: ink.strong },
  whenLive: { color: live.l700 },
  lines: { display: "flex", flexDirection: "column", gap: 2, flexGrow: 1, flexBasis: 200, minWidth: 0 },
  title: { margin: 0, fontSize: text.base, fontWeight: weight.medium, color: ink.strong },
  meta: { margin: 0, fontSize: "0.8125rem", color: ink.muted },
  quiet: { margin: 0, fontSize: text.sm, color: ink.muted },
  primary: {
    display: "inline-flex",
    alignItems: "center",
    height: 40,
    paddingInline: 18,
    borderRadius: 999,
    fontSize: text.sm,
    fontWeight: weight.medium,
    textDecorationLine: "none",
    color: ink.onAccent,
    backgroundColor: { default: accent.a600, [env.hoverable]: { default: accent.a600, ":hover": accent.a700 } },
  },
  secondary: {
    display: "inline-flex",
    alignItems: "center",
    height: 40,
    paddingInline: space.s4,
    borderRadius: 999,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: border.base,
    cursor: "pointer",
    fontFamily: "inherit",
    fontSize: text.sm,
    fontWeight: weight.medium,
    textDecorationLine: "none",
    color: ink.strong,
    backgroundColor: { default: "transparent", [env.hoverable]: { default: "transparent", ":hover": neutral.n100 } },
  },
  justEnded: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space.s4,
    paddingBlock: space.s4,
    paddingInline: space.s5,
    borderRadius: 16,
    backgroundColor: accent.a50,
    boxShadow: `0 0 0 1px ${accent.a200}`,
  },
  dismiss: {
    display: "grid",
    placeItems: "center",
    width: 44,
    height: 44,
    padding: 0,
    borderWidth: 0,
    borderRadius: 999,
    cursor: "pointer",
    color: ink.muted,
    backgroundColor: { default: "transparent", [env.hoverable]: { default: "transparent", ":hover": accent.a100 } },
  },
});

// ─── Just ended ──────────────────────────────────────────────────────────────

/** Long enough for the meeting's end to land, not so long it polls forever. */
const JUST_ENDED_WATCH_MS = 60_000;
const JUST_ENDED_POLL_MS = 4_000;

/**
 * The meeting you just walked out of, once it is over, with the way to what it
 * left. Nothing while others are still in it: Upcoming already offers those back.
 */
export function JustEnded({
  meetingId,
  viewerName,
  onDismiss,
}: {
  meetingId: string;
  viewerName: string;
  onDismiss: () => void;
}) {
  const [watchUntil] = useState(() => Date.now() + JUST_ENDED_WATCH_MS);
  const isThis = (meeting: { meetingId: string }) => meeting.meetingId === meetingId;
  const query = useInfiniteQuery({
    ...homeRecentMeetingsQueryOptions(),
    refetchInterval: (current) =>
      current.state.data?.pages[0]?.meetings.some(isThis) || Date.now() > watchUntil ? false : JUST_ENDED_POLL_MS,
  });
  const meeting = query.data?.pages[0]?.meetings.find(isThis);
  if (!meeting) return null;

  return (
    <section aria-label="Meeting that just ended" {...stylex.props(styles.justEnded, enter.fadeUp)}>
      <div {...stylex.props(styles.lines)}>
        <h2 {...stylex.props(styles.title, layout.truncate)}>
          {meetingDisplayTitle(meeting.title, meeting.participantNames, viewerName)} just ended
        </h2>
      </div>
      <Link to="/meetings/$meetingId" params={{ meetingId }} {...stylex.props(styles.primary, motion.tint, focus.ring)}>
        Open meeting
      </Link>
      <button type="button" aria-label="Dismiss" onClick={onDismiss} {...stylex.props(styles.dismiss, motion.tint, focus.ring)}>
        <X size={16} aria-hidden="true" />
      </button>
    </section>
  );
}

// ─── Upcoming ────────────────────────────────────────────────────────────────

function isSameLocalDay(iso: string, now: number): boolean {
  return new Date(iso).toDateString() === new Date(now).toDateString();
}

function isTomorrow(iso: string, now: number): boolean {
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  return new Date(iso).toDateString() === tomorrow.toDateString();
}

/** "Today, 6:00 PM", "Tomorrow, 6:00 PM", "Wed, 10:00 AM", in the viewer's own time. */
function formatWhen(iso: string, now: number): string {
  const clock = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(iso));
  if (isSameLocalDay(iso, now)) return `Today, ${clock}`;
  if (isTomorrow(iso, now)) return `Tomorrow, ${clock}`;
  const day = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" }).format(new Date(iso));
  return `${day}, ${clock}`;
}

/**
 * What you would act on next: anything happening now, the next few scheduled
 * meetings, and your own meeting link under them.
 */
export function Upcoming({ threads, now, children }: { threads: Thread[]; now: number; children?: ReactNode }) {
  const query = useSuspenseInfiniteQuery(myUpcomingMeetingSchedulesQueryOptions());
  const [scheduling, setScheduling] = useState(false);
  const upcoming = query.data.pages
    .flatMap((page) => page.schedules)
    .filter((item) => item.state === "upcoming" || item.state === "late_start")
    .slice(0, UPCOMING_LIMIT);
  const liveNow = threads.flatMap((thread) =>
    thread.openMeeting && thread.openMeeting.participantCount > 0 ? [{ thread, meeting: thread.openMeeting }] : [],
  );

  return (
    <section aria-labelledby="home-upcoming" {...stylex.props(styles.section, enter.fadeUp)}>
      <div {...stylex.props(styles.head)}>
        <h2 id="home-upcoming" {...stylex.props(styles.heading)}>Upcoming</h2>
        <div {...stylex.props(styles.headActions)}>
          <Link to="/calendar" {...stylex.props(touch.target, styles.headLink, focus.ring)}>Calendar</Link>
          <button type="button" onClick={() => setScheduling(true)} {...stylex.props(styles.secondary, motion.tint, focus.ring)}>
            Schedule a meeting
          </button>
        </div>
      </div>
      <ul {...stylex.props(styles.list)}>
        {liveNow.map(({ thread, meeting }) => (
          <li key={meeting.meetingId} {...stylex.props(styles.row)}>
            <span {...stylex.props(styles.when, styles.whenLive)}>Happening now</span>
            <div {...stylex.props(styles.lines)}>
              <h3 {...stylex.props(styles.title, layout.truncate)}>{meeting.title?.trim() || thread.title}</h3>
              <p {...stylex.props(styles.meta)}>{meeting.participantCount} in the meeting</p>
            </div>
            <a
              href={`/${meeting.code}`}
              onClick={() => beginMeetingEntryFlow({ source: "home-join", code: meeting.code })}
              {...stylex.props(styles.primary, motion.tint, focus.ring)}
            >
              Join
            </a>
          </li>
        ))}
        {upcoming.map((meeting) => (
          <li key={meeting.id} {...stylex.props(styles.row)}>
            <time dateTime={meeting.startsAt} {...stylex.props(styles.when)}>{formatWhen(meeting.startsAt, now)}</time>
            <div {...stylex.props(styles.lines)}>
              <h3 {...stylex.props(styles.title, layout.truncate)}>{meeting.title?.trim() || "Scheduled meeting"}</h3>
              <p {...stylex.props(styles.meta)}>
                {meeting.state === "late_start" ? "Not started yet · " : ""}
                {meeting.spaceName ?? `Organized by ${meeting.organizerName}`}
              </p>
            </div>
            <a
              href={`/${meeting.code}`}
              onClick={() => beginMeetingEntryFlow({ source: "meetings-upcoming", code: meeting.code })}
              {...stylex.props(meeting.state === "late_start" ? styles.primary : styles.secondary, motion.tint, focus.ring)}
            >
              Join
            </a>
          </li>
        ))}
        {liveNow.length === 0 && upcoming.length === 0 ? (
          <li {...stylex.props(styles.row)}>
            <p {...stylex.props(styles.quiet)}>Nothing scheduled.</p>
          </li>
        ) : null}
        {children}
      </ul>
      <ScheduleMeetingDialog open={scheduling} onOpenChange={setScheduling} />
    </section>
  );
}
