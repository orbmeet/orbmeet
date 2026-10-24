import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import * as stylex from "@stylexjs/stylex";
import { endedMeetingQueryOptions } from "@/app/query-client/queries/meeting-summary";
import { myThreadsQueryOptions } from "@/app/query-client/queries/meetings";
import { beginMeetingEntryFlow } from "@/modules/meetings/client/entry-metrics";
import { meetingEntryPath } from "@/modules/meetings/client/urls";
import { FollowUpList } from "@/modules/transcripts/client/follow-up-list";
import type { UpcomingMeetingSchedule } from "@/modules/scheduling/client/schedule-meeting-dialog";
import { Avatar, BrandMark } from "@orbmeet/ui/react";
import { enter } from "@orbmeet/ui/styles/animations";
import { focus, layout, motion } from "@orbmeet/ui/styles/atoms";
import { accent, border, ink, live, neutral, surface } from "@orbmeet/ui/tokens/colors.stylex";
import { env } from "@orbmeet/ui/tokens/media.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { fonts, text, weight } from "@orbmeet/ui/tokens/typography.stylex";

export type EventKind = "past" | "pastSpace" | "live" | "planned";

export interface CalendarEvent {
  id: string;
  title: string;
  start: Date;
  end: Date;
  kind: EventKind;
  spaceId?: string | null;
  spaceName?: string | null;
  participantNames?: string[];
  /** A past meeting: its recap. */
  meetingId?: string;
  /** A meeting on now: its room. */
  code?: string;
  schedule?: UpcomingMeetingSchedule;
}

const styles = stylex.create({
  panel: { display: "flex", flexDirection: "column", gap: space.s6 },
  state: { display: "flex", alignItems: "center", gap: space.s2, fontSize: "0.8125rem", fontWeight: weight.medium, color: ink.muted },
  stateLive: { color: live.l700 },
  stateSoon: { color: accent.a700 },
  dot: { width: 7, height: 7, borderRadius: "50%", backgroundColor: "currentColor" },
  title: {
    margin: 0,
    marginTop: space.s2,
    fontFamily: fonts.heading,
    fontSize: "1.5rem",
    fontWeight: weight.semibold,
    letterSpacing: "-0.035em",
    lineHeight: 1.15,
    color: ink.strong,
    overflowWrap: "anywhere",
  },
  meta: { margin: 0, marginTop: space.s1_5, fontSize: text.sm, color: ink.muted },
  actions: { display: "flex", flexWrap: "wrap", gap: space.s2 },
  primary: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flexGrow: 1,
    height: 44,
    paddingInline: space.s5,
    borderWidth: 0,
    borderRadius: 999,
    cursor: "pointer",
    fontSize: text.sm,
    fontWeight: weight.medium,
    textDecorationLine: "none",
    color: ink.onAccent,
    backgroundColor: { default: accent.a600, [env.hoverable]: { default: accent.a600, ":hover": accent.a700 } },
  },
  quiet: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    height: 44,
    paddingInline: space.s5,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: border.base,
    borderRadius: 999,
    cursor: "pointer",
    fontSize: text.sm,
    fontWeight: weight.medium,
    textDecorationLine: "none",
    color: ink.strong,
    backgroundColor: { default: "transparent", [env.hoverable]: { default: "transparent", ":hover": neutral.n100 } },
  },
  label: { margin: 0, marginBottom: space.s2_5, fontSize: text.xs, fontWeight: weight.medium, color: ink.muted },
  people: { margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: space.s2 },
  person: { display: "flex", alignItems: "center", gap: space.s2_5, fontSize: text.sm, color: ink.strong },
  card: {
    display: "flex",
    flexDirection: "column",
    gap: space.s3,
    padding: space.s4,
    borderRadius: 16,
    backgroundColor: surface.raised,
    boxShadow: `0 0 0 1px ${border.subtle}`,
  },
  cardHead: { display: "flex", alignItems: "center", gap: space.s2, fontSize: "0.8125rem", fontWeight: weight.semibold, color: ink.strong },
  excerpt: {
    margin: 0,
    fontSize: text.sm,
    lineHeight: 1.5,
    color: ink.body,
    display: "-webkit-box",
    WebkitLineClamp: 4,
    WebkitBoxOrient: "vertical",
    overflow: "hidden",
  },
  cardLink: { alignSelf: "flex-start", fontSize: "0.8125rem", fontWeight: weight.medium, color: accent.a700, textDecorationLine: "none" },
  empty: { margin: 0, fontSize: text.sm, lineHeight: 1.5, color: ink.muted },
});

function clock(date: Date): string {
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** "Today, 3:30 – 4:30 PM", "Thu, Oct 15, 2:00 – 3:00 PM". */
function when(event: CalendarEvent, now: number): string {
  const today = new Date(now).toDateString() === event.start.toDateString();
  const day = today ? "Today" : event.start.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  return event.kind === "live" ? `${day}, since ${clock(event.start)}` : `${day}, ${clock(event.start)} – ${clock(event.end)}`;
}

function minutesBetween(from: number, to: number): number {
  return Math.max(0, Math.round((to - from) / 60_000));
}

function sayDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  return minutes % 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes / 60} h`;
}

function stateOf(event: CalendarEvent, now: number): { label: string; tone: "live" | "soon" | "quiet" } {
  if (event.kind === "live") return { label: "Happening now", tone: "live" };
  if (event.kind === "planned") {
    if (event.schedule?.state === "late_start") return { label: "Not started yet", tone: "soon" };
    const until = minutesBetween(now, event.start.getTime());
    return { label: until < 24 * 60 ? `In ${sayDuration(until)}` : "Scheduled", tone: "soon" };
  }
  return { label: `Ended · ${sayDuration(minutesBetween(event.start.getTime(), event.end.getTime()))}`, tone: "quiet" };
}

/** What a past meeting left: the start of its recap, and what people agreed to do. */
function Outcome({ meetingId, heading, linkLabel }: { meetingId: string; heading: string; linkLabel: string }) {
  const query = useQuery(endedMeetingQueryOptions(meetingId));
  const summary = query.data?.summary?.summary;
  const followUps = query.data?.followUps ?? [];
  return (
    <section aria-label={heading} {...stylex.props(styles.card, enter.fadeUp)}>
      <span {...stylex.props(styles.cardHead)}>
        <BrandMark size={16} />
        {heading}
      </span>
      {query.isPending ? (
        <p {...stylex.props(styles.empty)}>Loading…</p>
      ) : summary || followUps.length > 0 ? (
        <>
          {summary ? <p {...stylex.props(styles.excerpt)}>{summary}</p> : null}
          {followUps.length > 0 ? (
            <FollowUpList
              meetingId={meetingId}
              items={followUps.map((followUp) => ({ id: followUp.id, text: followUp.text, done: followUp.done, detail: followUp.ownerName ?? undefined }))}
            />
          ) : null}
        </>
      ) : (
        <p {...stylex.props(styles.empty)}>No recap for this one — nothing was transcribed.</p>
      )}
      <Link to="/meetings/$meetingId" params={{ meetingId }} {...stylex.props(styles.cardLink, focus.ring)}>
        {linkLabel}
      </Link>
    </section>
  );
}

/**
 * For a meeting in a Space, what is still open from the Space's last one: the
 * next meeting starts where that one stopped, not from a blank page.
 */
function FromLastTime({ spaceId }: { spaceId: string }) {
  const threads = useQuery(myThreadsQueryOptions());
  const thread = threads.data?.threads.find((item) => item.kind === "space" && item.id === spaceId);
  const latest = thread?.latestMeeting;
  if (!latest || !latest.endedAt) return null;
  return <Outcome meetingId={latest.meetingId} heading={`From last time in ${thread.title}`} linkLabel="Open last recap →" />;
}

/**
 * The selected meeting, beside the week: its state, the one thing to do about
 * it, who is in it, and what it carries — what it left if it is over, or what
 * is still open from last time if it is still to come.
 */
export function EventDetail({
  event,
  now,
  onEditSchedule,
}: {
  event: CalendarEvent;
  now: number;
  onEditSchedule: (schedule: UpcomingMeetingSchedule) => void;
}) {
  const state = stateOf(event, now);
  const schedule = event.schedule;
  const spaceName = event.spaceName ?? schedule?.spaceName ?? null;
  const spaceId = event.spaceId ?? schedule?.spaceId ?? null;
  const people = event.participantNames ?? [];
  const code = event.code;

  return (
    <div key={event.id} {...stylex.props(styles.panel, enter.fadeUp)}>
      <div>
        <span {...stylex.props(styles.state, state.tone === "live" && styles.stateLive, state.tone === "soon" && styles.stateSoon)}>
          <span aria-hidden="true" {...stylex.props(styles.dot)} />
          {state.label}
        </span>
        <h2 {...stylex.props(styles.title)}>{event.title}</h2>
        <p {...stylex.props(styles.meta)}>{when(event, now)}</p>
        {spaceName || schedule ? (
          <p {...stylex.props(styles.meta)}>
            {[spaceName ?? (schedule ? `Organized by ${schedule.organizerName}` : null), schedule && schedule.attendeeCount > 0 ? `${schedule.attendeeCount} invited` : null]
              .filter(Boolean)
              .join(" · ")}
          </p>
        ) : null}
      </div>

      <div {...stylex.props(styles.actions)}>
        {event.kind === "live" && code ? (
          <a
            href={meetingEntryPath(code)}
            onClick={() => beginMeetingEntryFlow({ source: "calendar-live", code })}
            {...stylex.props(styles.primary, motion.tint, focus.ring)}
          >
            Join
          </a>
        ) : null}
        {event.meetingId ? (
          <Link to="/meetings/$meetingId" params={{ meetingId: event.meetingId }} {...stylex.props(styles.primary, motion.tint, focus.ring)}>
            Open recap
          </Link>
        ) : null}
        {schedule ? (
          <>
            <a
              href={meetingEntryPath(schedule.code)}
              onClick={() => beginMeetingEntryFlow({ source: "meetings-upcoming", code: schedule.code })}
              {...stylex.props(styles.primary, motion.tint, focus.ring)}
            >
              Open meeting
            </a>
            <button type="button" onClick={() => onEditSchedule(schedule)} {...stylex.props(styles.quiet, motion.tint, focus.ring)}>
              Edit
            </button>
          </>
        ) : null}
      </div>

      {people.length > 0 ? (
        <section aria-label={event.kind === "live" ? "In the room" : "Who was there"}>
          <h3 {...stylex.props(styles.label)}>{event.kind === "live" ? "In the room" : "Who was there"}</h3>
          <ul {...stylex.props(styles.people)}>
            {people.slice(0, 6).map((name) => (
              <li key={name} {...stylex.props(styles.person)}>
                <Avatar name={name} size="sm" />
                <span {...stylex.props(layout.truncate)}>{name}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {event.meetingId ? (
        <Outcome meetingId={event.meetingId} heading="What it left" linkLabel="Open the board and recap →" />
      ) : spaceId ? (
        <FromLastTime spaceId={spaceId} />
      ) : null}
    </div>
  );
}
