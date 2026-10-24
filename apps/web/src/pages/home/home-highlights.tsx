import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery, useSuspenseInfiniteQuery } from "@tanstack/react-query";
import * as stylex from "@stylexjs/stylex";
import { myOpenFollowUpsQueryOptions, myUpcomingMeetingSchedulesQueryOptions } from "@/app/query-client/queries/meetings";
import { formatMeetingDate } from "@/modules/meetings/client/components/meeting-format";
import { FollowUpList } from "@/modules/transcripts/client/follow-up-list";
import { beginMeetingEntryFlow } from "@/modules/meetings/client/entry-metrics";
import { ScheduleMeetingDialog } from "@/modules/scheduling/client/schedule-meeting-dialog";
import type { Thread } from "@/modules/meetings/contract/threads";
import { enter } from "@orbmeet/ui/styles/animations";
import { focus, layout, motion, touch } from "@orbmeet/ui/styles/atoms";
import { accent, border, ink, live, neutral, surface } from "@orbmeet/ui/tokens/colors.stylex";
import { bp, env } from "@orbmeet/ui/tokens/media.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { fonts, text, weight } from "@orbmeet/ui/tokens/typography.stylex";

const styles = stylex.create({
  // A section of the page, not a box: the page is the frame.
  section: { display: "flex", flexDirection: "column", gap: space.s3 },
  head: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: space.s3 },
  heading: { margin: 0, fontSize: "0.9375rem", fontWeight: weight.semibold, color: ink.strong },
  headLink: {
    fontSize: "0.8125rem",
    fontWeight: weight.medium,
    color: accent.a700,
    textDecorationLine: "none",
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    cursor: "pointer",
  },
  count: { fontFamily: fonts.mono, fontSize: "0.8125rem", color: ink.muted },
  lede: { margin: 0, marginTop: `calc(-1 * ${space.s2})`, fontSize: "0.8125rem", color: ink.muted },

  /** The day as a timeline: a time, then what happens at it. */
  timeline: { margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: space.s2 },
  // On a phone the time sits above its card; from a tablet up it is a column.
  slot: {
    display: "grid",
    gridTemplateColumns: { default: "minmax(0, 1fr)", [bp.sm]: "76px minmax(0, 1fr)" },
    gap: { default: space.s1_5, [bp.sm]: space.s4 },
    alignItems: "start",
  },
  time: { fontFamily: fonts.mono, fontSize: "0.8125rem", color: ink.muted, paddingTop: { default: 0, [bp.sm]: 18 } },
  timeLive: { color: live.l700, fontWeight: weight.medium },
  card: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space.s4,
    paddingBlock: space.s4,
    paddingInline: space.s5,
    borderRadius: 16,
    boxShadow: `0 0 0 1px ${border.subtle}`,
    backgroundColor: surface.raised,
  },
  cardLive: { backgroundColor: accent.a50, boxShadow: `0 0 0 1px ${accent.a200}` },
  lines: { display: "flex", flexDirection: "column", gap: 3, flexGrow: 1, flexBasis: 200, minWidth: 0 },
  title: { margin: 0, fontSize: text.base, fontWeight: weight.semibold, color: ink.strong },
  meta: { margin: 0, fontSize: "0.8125rem", color: ink.muted },
  metaLive: { color: live.l700, fontWeight: weight.medium },
  dot: { flexShrink: 0, width: 8, height: 8, borderRadius: "50%", backgroundColor: live.l500, boxShadow: `0 0 0 4px color-mix(in oklab, ${live.l500} 22%, transparent)` },
  primary: {
    display: "inline-flex",
    alignItems: "center",
    height: 40,
    paddingInline: 18,
    borderRadius: 999,
    fontSize: text.sm,
    fontWeight: weight.medium,
    textDecorationLine: "none",
    color: surface.raised,
    backgroundColor: { default: ink.strong, [env.hoverable]: { default: ink.strong, ":hover": neutral.n800 } },
  },
  secondary: {
    display: "inline-flex",
    alignItems: "center",
    height: 36,
    paddingInline: space.s3_5,
    borderRadius: 999,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: border.base,
    fontSize: "0.8125rem",
    fontWeight: weight.medium,
    textDecorationLine: "none",
    color: ink.strong,
    backgroundColor: { default: "transparent", [env.hoverable]: { default: "transparent", ":hover": neutral.n100 } },
  },
  quietCard: { boxShadow: "none", backgroundColor: surface.sunken },
});

// ─── Today ───────────────────────────────────────────────────────────────────

function isSameLocalDay(iso: string, now: number): boolean {
  return new Date(iso).toDateString() === new Date(now).toDateString();
}

function formatClock(iso: string, timeZone?: string): string {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", timeZone }).format(new Date(iso));
}

function formatElapsed(iso: string | null, now: number): string {
  if (!iso) return "just started";
  const minutes = Math.floor((now - Date.parse(iso)) / 60_000);
  if (minutes < 1) return "just started";
  if (minutes < 60) return `started ${minutes} min ago`;
  return `started ${Math.floor(minutes / 60)} h ${minutes % 60} min ago`;
}

/** "in 12 min", "in 1 h 30 min": how long until a time later today. */
function formatUntil(iso: string, now: number): string {
  const minutes = Math.max(0, Math.round((Date.parse(iso) - now) / 60_000));
  if (minutes < 1) return "starting now";
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `in ${hours} h ${minutes % 60} min` : `in ${hours} h`;
}

/**
 * The day as a timeline: what is happening now, then what is still to come
 * today, each with the one thing you would do about it. Past meetings are
 * not here — they are what follows, under Earlier.
 */
export function Today({ threads, now }: { threads: Thread[]; now: number }) {
  const query = useSuspenseInfiniteQuery(myUpcomingMeetingSchedulesQueryOptions());
  const [scheduling, setScheduling] = useState(false);
  const upcoming = query.data.pages
    .flatMap((page) => page.schedules)
    .filter((item) => item.state === "upcoming" || item.state === "late_start");
  const today = upcoming.filter((item) => isSameLocalDay(item.startsAt, now));
  const next = upcoming.find((item) => !isSameLocalDay(item.startsAt, now));
  const liveNow = threads.flatMap((thread) =>
    thread.openMeeting && thread.openMeeting.participantCount > 0 ? [{ thread, meeting: thread.openMeeting }] : [],
  );

  return (
    <section aria-labelledby="home-today" {...stylex.props(styles.section, enter.fadeUp)}>
      <div {...stylex.props(styles.head)}>
        <h2 id="home-today" {...stylex.props(styles.heading)}>Today</h2>
        <Link to="/calendar" {...stylex.props(touch.target, styles.headLink, focus.ring)}>Open calendar</Link>
      </div>
      <ol {...stylex.props(styles.timeline)}>
        {liveNow.map(({ thread, meeting }) => (
          <li key={meeting.meetingId} {...stylex.props(styles.slot)}>
            <span {...stylex.props(styles.time, styles.timeLive)}>Now</span>
            <div {...stylex.props(styles.card, styles.cardLive)}>
              <span aria-hidden="true" {...stylex.props(styles.dot)} />
              <div {...stylex.props(styles.lines)}>
                <h3 {...stylex.props(styles.title, layout.truncate)}>{meeting.title?.trim() || thread.title}</h3>
                <p {...stylex.props(styles.meta)}>
                  <span {...stylex.props(styles.metaLive)}>Happening now</span>
                  {` · ${meeting.participantCount} in the room · ${formatElapsed(meeting.startedAt, now)}`}
                </p>
              </div>
              <a
                href={`/${meeting.code}`}
                onClick={() => beginMeetingEntryFlow({ source: "home-join", code: meeting.code })}
                {...stylex.props(styles.primary, motion.tint, focus.ring)}
              >
                Join
              </a>
            </div>
          </li>
        ))}
        {today.map((meeting) => (
          <li key={meeting.id} {...stylex.props(styles.slot)}>
            <time dateTime={meeting.startsAt} {...stylex.props(styles.time)}>{formatClock(meeting.startsAt, meeting.timeZone)}</time>
            <div {...stylex.props(styles.card)}>
              <div {...stylex.props(styles.lines)}>
                <h3 {...stylex.props(styles.title, layout.truncate)}>{meeting.title?.trim() || "Scheduled meeting"}</h3>
                <p {...stylex.props(styles.meta)}>
                  {meeting.state === "late_start" ? "Not started yet" : formatUntil(meeting.startsAt, now)}
                  {" · "}
                  {meeting.spaceName ?? `Organized by ${meeting.organizerName}`}
                  {meeting.attendeeCount > 0 ? ` · ${meeting.attendeeCount} invited` : ""}
                </p>
              </div>
              <a
                href={`/${meeting.code}`}
                onClick={() => beginMeetingEntryFlow({ source: "meetings-upcoming", code: meeting.code })}
                {...stylex.props(meeting.state === "late_start" ? styles.primary : styles.secondary, motion.tint, focus.ring)}
              >
                Open meeting
              </a>
            </div>
          </li>
        ))}
        {liveNow.length === 0 && today.length === 0 ? (
          // Nothing at a time, so no time column: the card takes the row.
          <li>
            <div {...stylex.props(styles.card, styles.quietCard)}>
              <div {...stylex.props(styles.lines)}>
                <h3 {...stylex.props(styles.title)}>Nothing else today</h3>
                <p {...stylex.props(styles.meta)}>
                  {next
                    ? `Next: ${next.title?.trim() || "Scheduled meeting"}, ${new Intl.DateTimeFormat(undefined, { weekday: "short", hour: "numeric", minute: "2-digit", timeZone: next.timeZone }).format(new Date(next.startsAt))}`
                    : "Your calendar is clear."}
                </p>
              </div>
              <button type="button" onClick={() => setScheduling(true)} {...stylex.props(styles.secondary, motion.tint, focus.ring)}>
                Schedule a meeting
              </button>
            </div>
          </li>
        ) : null}
      </ol>
      <ScheduleMeetingDialog open={scheduling} onOpenChange={setScheduling} />
    </section>
  );
}

// ─── Still to do ─────────────────────────────────────────────────────────────

/** "today", "yesterday", "Thu, Oct 15": a day as it reads mid-sentence. */
function sayWhen(day: string): string {
  return day === "Today" || day === "Yesterday" ? day.toLowerCase() : day;
}

/**
 * What people agreed to do in recent meetings and nobody has done yet, so it
 * is seen without opening each recap. Ticking one off here ticks it off in its
 * meeting too. Not there at all until there is something to show: Home never
 * waits on it, and an empty list would only be noise.
 */
export function StillToDo() {
  const query = useQuery(myOpenFollowUpsQueryOptions());
  const followUps = query.data?.followUps ?? [];
  if (followUps.length === 0) return null;
  const open = followUps.filter((followUp) => !followUp.done).length;

  return (
    <section aria-labelledby="home-todo-title" {...stylex.props(styles.section, enter.fadeUp)}>
      <div {...stylex.props(styles.head)}>
        <h2 id="home-todo-title" {...stylex.props(styles.heading)}>Still to do</h2>
        <span {...stylex.props(styles.count)}>{open} open</span>
      </div>
      <p {...stylex.props(styles.lede)}>What people agreed to in meetings.</p>
      <FollowUpList
        items={followUps.map((followUp) => ({
          id: followUp.id,
          text: followUp.text,
          done: followUp.done,
          detail: [
            followUp.ownerName,
            `${followUp.meetingTitle?.trim() || "A call"}, ${sayWhen(formatMeetingDate(followUp.meetingStartedAt))}`,
          ]
            .filter(Boolean)
            .join(" · "),
        }))}
      />
    </section>
  );
}
