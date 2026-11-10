import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { CalendarPlus, ChevronLeft, ChevronRight } from "lucide-react";
import { myMeetingsQueryOptions, myUpcomingMeetingSchedulesQueryOptions } from "@/app/query-client/queries/meetings";
import { useAuthenticatedSession } from "@/app/query-client/use-authenticated-session";
import { meetingDisplayTitle } from "@/modules/meetings/client/components/meeting-format";
import { MeetingOutputActions, type MeetingOutputs } from "@/modules/meetings/client/components/meeting-output-actions";
import { beginMeetingEntryFlow } from "@/modules/meetings/client/entry-metrics";
import { meetingEntryPath } from "@/modules/meetings/client/urls";
import { CancelScheduledMeetingDialog, ScheduleMeetingDialog, type UpcomingMeetingSchedule } from "@/modules/scheduling/client/schedule-meeting-dialog";
import { useNow } from "@/lib/hooks/use-now";
import { Button } from "@orbmeet/ui/react";
import { enter } from "@orbmeet/ui/styles/animations";
import { focus, layout, motion } from "@orbmeet/ui/styles/atoms";
import { accent, border, danger, ink, live, neutral, surface } from "@orbmeet/ui/tokens/colors.stylex";
import { bp, env } from "@orbmeet/ui/tokens/media.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { fonts, text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";
import { addDays, fromDateParam, occursOnDay, sameDay, startOfWeek, toDateParam } from "./calendar-week";

const routeApi = getRouteApi("/_authed/calendar/");

type CalendarEvent = {
  id: string;
  title: string;
  start: Date;
  end: Date;
  detail: string | null;
} & (
  | { kind: "past"; outputs: MeetingOutputs }
  | { kind: "live"; code: string }
  | { kind: "planned"; schedule: UpcomingMeetingSchedule }
);

const styles = stylex.create({
  page: { maxWidth: 1100, marginInline: "auto", display: "flex", flexDirection: "column", gap: space.s5, paddingTop: { default: space.s4, [bp.lg]: space.s7 } },
  bar: { display: "flex", flexWrap: "wrap", alignItems: "flex-end", gap: space.s3 },
  heading: { display: "flex", flexDirection: "column", gap: space.s1, flexGrow: 1, flexBasis: 280, minWidth: 0 },
  relative: { fontSize: "0.8125rem", fontWeight: weight.semibold, color: accent.a700, minHeight: 18 },
  title: {
    margin: 0,
    fontFamily: fonts.heading,
    fontWeight: weight.semibold,
    fontSize: { default: "2rem", [bp.sm]: "2.5rem" },
    lineHeight: 1.05,
    letterSpacing: "-0.045em",
    color: ink.strong,
  },
  nav: { display: "flex", gap: space.s1 },
  navButton: {
    display: "grid",
    placeItems: "center",
    minWidth: 44,
    height: 44,
    paddingInline: space.s3,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: border.base,
    borderRadius: 12,
    cursor: "pointer",
    fontFamily: "inherit",
    fontSize: text.sm,
    fontWeight: weight.medium,
    color: ink.strong,
    backgroundColor: { default: surface.raised, [env.hoverable]: { default: surface.raised, ":hover": neutral.n50 } },
  },
  /** The week around the date shown: a press goes to that day. */
  week: { display: "grid", gridTemplateColumns: "repeat(7, minmax(0, 1fr))", gap: space.s1_5 },
  day: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 1,
    minHeight: 76,
    paddingBlock: space.s2,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: border.subtle,
    borderRadius: 14,
    color: ink.strong,
    textDecorationLine: "none",
    backgroundColor: { default: surface.raised, [env.hoverable]: { default: surface.raised, ":hover": neutral.n50 } },
  },
  dayOn: { borderColor: accent.a600, color: ink.onAccent, backgroundColor: accent.a600 },
  dow: { fontSize: "0.8125rem" },
  num: { fontSize: "1.25rem", fontWeight: weight.semibold, lineHeight: 1.2 },
  count: { fontSize: text.xs, minHeight: 16 },
  list: { margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", borderRadius: 18, boxShadow: `0 0 0 1px ${border.subtle}`, backgroundColor: surface.raised },
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
  time: { flexShrink: 0, width: { default: "100%", [bp.sm]: 160 }, fontFamily: fonts.mono, fontSize: "0.8125rem", color: ink.body },
  timeLive: { color: live.l700, fontWeight: weight.semibold },
  body: { display: "flex", flexDirection: "column", gap: 2, flexGrow: 1, flexBasis: 200, minWidth: 0 },
  eventTitle: { margin: 0, fontSize: text.base, fontWeight: weight.medium, color: ink.strong },
  eventLink: { color: "inherit", textDecorationLine: "none" },
  detail: { margin: 0, fontSize: "0.8125rem", color: ink.muted },
  actions: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: space.s2 },
  join: {
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
  quiet: {
    minHeight: 40,
    paddingInline: space.s2,
    borderWidth: 0,
    borderRadius: 8,
    cursor: "pointer",
    fontFamily: "inherit",
    fontSize: text.sm,
    fontWeight: weight.medium,
    color: ink.body,
    backgroundColor: "transparent",
  },
  quietDanger: { color: danger.d700 },
  empty: { margin: 0, paddingBlock: space.s8, textAlign: "center", fontSize: text.sm, color: ink.muted },
});

function shortTime(date: Date): string {
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/**
 * Keeps loading pages of a feed until `enough` says the shown days are
 * covered or the feed runs out. A week is small, so this is a few pages at
 * most; stopping at the first would leave a busy week half drawn.
 */
function useLoadUntil(
  query: { hasNextPage: boolean; isFetchingNextPage: boolean; isError: boolean; fetchNextPage: () => Promise<unknown> },
  enough: boolean,
) {
  const { hasNextPage, isFetchingNextPage, isError, fetchNextPage } = query;
  useEffect(() => {
    if (!enough && hasNextPage && !isFetchingNextPage && !isError) void fetchNextPage();
  }, [enough, hasNextPage, isFetchingNextPage, isError, fetchNextPage]);
}

/** Everything in the shown days: what happened, what is happening, and what is planned. */
function useEvents(days: Date[], viewerName: string, now: number): CalendarEvent[] {
  const from = days[0].getTime();
  const to = addDays(days[days.length - 1], 1).getTime();
  // Bounded on both sides: newest first with only a start would fill its
  // pages with meetings after the shown days and leave them empty.
  const past = useInfiniteQuery(myMeetingsQueryOptions({ status: "ended", since: from, until: to, limit: 100 }));
  const open = useInfiniteQuery(myMeetingsQueryOptions({ status: "open", limit: 100 }));
  const planned = useInfiniteQuery(myUpcomingMeetingSchedulesQueryOptions());
  useLoadUntil(past, false);
  // Schedules come soonest first: the shown days are covered once a page
  // reaches past their end.
  const lastPlanned = planned.data?.pages.at(-1)?.schedules.at(-1);
  useLoadUntil(planned, lastPlanned ? Date.parse(lastPlanned.startsAt) >= to : false);

  return useMemo(() => {
    const events: CalendarEvent[] = [];
    for (const meeting of past.data?.pages.flatMap((page) => page.meetings) ?? []) {
      if (!meeting.startedAt) continue;
      const start = new Date(meeting.startedAt);
      if (start.getTime() >= to) continue;
      const others = meeting.participantNames.filter((name) => name !== viewerName);
      events.push({
        id: `m:${meeting.id}`,
        title: meetingDisplayTitle(meeting.title, meeting.participantNames, viewerName),
        start,
        end: new Date(meeting.endedAt ?? meeting.startedAt),
        detail: [others.join(", "), meeting.spaceName].filter(Boolean).join(" · ") || null,
        kind: "past",
        outputs: {
          meetingId: meeting.id,
          hasWhiteboard: meeting.hasWhiteboardState || meeting.hasWhiteboardPdf,
          hasWhiteboardPdf: meeting.hasWhiteboardPdf,
          hasRecording: meeting.hasRecording,
          hasSummary: meeting.hasSummary,
        },
      });
    }
    for (const meeting of open.data?.pages.flatMap((page) => page.meetings) ?? []) {
      if (!meeting.startedAt) continue;
      events.push({
        id: `m:${meeting.id}`,
        title: meeting.title || meeting.spaceName || "Meeting",
        start: new Date(meeting.startedAt),
        end: new Date(Math.max(now, Date.parse(meeting.startedAt))),
        detail: meeting.spaceName,
        kind: "live",
        code: meeting.code,
      });
    }
    for (const schedule of planned.data?.pages.flatMap((page) => page.schedules) ?? []) {
      if (schedule.state !== "upcoming" && schedule.state !== "late_start") continue;
      const start = new Date(schedule.startsAt);
      if (start.getTime() >= to || Date.parse(schedule.endsAt) <= from) continue;
      events.push({
        id: `s:${schedule.id}`,
        title: schedule.title?.trim() || "Scheduled meeting",
        start,
        end: new Date(schedule.endsAt),
        detail: schedule.spaceName ?? `Organized by ${schedule.organizerName}`,
        kind: "planned",
        schedule,
      });
    }
    return events.sort((a, b) => a.start.getTime() - b.start.getTime());
  }, [past.data, open.data, planned.data, from, to, now, viewerName]);
}

function relativeLabel(day: Date, today: Date): string {
  if (sameDay(day, today)) return "Today";
  if (sameDay(day, addDays(today, 1))) return "Tomorrow";
  if (sameDay(day, addDays(today, -1))) return "Yesterday";
  return "";
}

function EventRow({
  event,
  onEdit,
  onCancel,
}: {
  event: CalendarEvent;
  onEdit: (schedule: UpcomingMeetingSchedule) => void;
  onCancel: (schedule: UpcomingMeetingSchedule) => void;
}) {
  return (
    <li {...stylex.props(styles.row)}>
      <span {...stylex.props(styles.time, event.kind === "live" && styles.timeLive)}>
        {event.kind === "live" ? "Happening now" : `${shortTime(event.start)}–${shortTime(event.end)}`}
      </span>
      <div {...stylex.props(styles.body)}>
        <h2 {...stylex.props(styles.eventTitle, layout.truncate)}>
          {event.kind === "past" ? (
            <Link to="/meetings/$meetingId" params={{ meetingId: event.outputs.meetingId }} {...stylex.props(styles.eventLink, focus.ring)}>
              {event.title}
            </Link>
          ) : (
            event.title
          )}
        </h2>
        {event.detail ? <p {...stylex.props(styles.detail, layout.truncate)}>{event.detail}</p> : null}
      </div>
      {event.kind === "past" ? <MeetingOutputActions meeting={event.outputs} title={event.title} /> : null}
      {event.kind === "live" ? (
        <a
          href={meetingEntryPath(event.code)}
          onClick={() => beginMeetingEntryFlow({ source: "calendar-live", code: event.code })}
          {...stylex.props(styles.join, motion.tint, focus.ring)}
        >
          Join
        </a>
      ) : null}
      {event.kind === "planned" ? (
        <div {...stylex.props(styles.actions)}>
          {event.schedule.canManage ? (
            <>
              <button type="button" onClick={() => onEdit(event.schedule)} {...stylex.props(styles.quiet, motion.tint, focus.ring)}>
                Edit
              </button>
              <button type="button" onClick={() => onCancel(event.schedule)} {...stylex.props(styles.quiet, styles.quietDanger, motion.tint, focus.ring)}>
                Cancel
              </button>
            </>
          ) : null}
          <a
            href={meetingEntryPath(event.schedule.code)}
            onClick={() => beginMeetingEntryFlow({ source: "meetings-upcoming", code: event.schedule.code })}
            {...stylex.props(styles.join, motion.tint, focus.ring)}
          >
            Join
          </a>
        </div>
      ) : null}
    </li>
  );
}

/**
 * One date at a time: the arrows move a day, the strip jumps within the week,
 * and every meeting on that date is listed at once, whatever hour it was.
 */
export function CalendarPage() {
  const search = routeApi.useSearch();
  const navigate = useNavigate();
  const { session: initialSession } = getRouteApi("/_authed").useRouteContext();
  const session = useAuthenticatedSession(initialSession);
  const now = useNow(60_000, true);
  const today = new Date(now);
  // Midnight, not now: a day shown from now on would leave out what already happened today.
  const anchor = fromDateParam(search.date, new Date(today.getFullYear(), today.getMonth(), today.getDate()));
  const days = Array.from({ length: 7 }, (_, i) => addDays(startOfWeek(anchor), i));
  const events = useEvents(days, session.user.name ?? "", now);
  const onDay = (day: Date) => events.filter((event) => occursOnDay(event.start, event.end, day));
  const shown = onDay(anchor);

  const [scheduling, setScheduling] = useState<{ schedule?: UpcomingMeetingSchedule } | null>(null);
  const [canceling, setCanceling] = useState<UpcomingMeetingSchedule | null>(null);

  const go = (date: Date | undefined) =>
    void navigate({ to: "/calendar", search: { date: date ? toDateParam(date) : undefined } });

  return (
    <div {...stylex.props(styles.page, enter.fadeUp)}>
      <div {...stylex.props(styles.bar)}>
        <div {...stylex.props(styles.heading)}>
          <span {...stylex.props(styles.relative)}>{relativeLabel(anchor, today)}</span>
          <h1 aria-live="polite" {...stylex.props(styles.title)}>
            {anchor.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}
          </h1>
        </div>
        <div {...stylex.props(styles.nav)}>
          <button type="button" aria-label="Previous day" onClick={() => go(addDays(anchor, -1))} {...stylex.props(styles.navButton, motion.tint, focus.ring)}>
            <ChevronLeft size={16} aria-hidden="true" />
          </button>
          <button type="button" onClick={() => go(undefined)} {...stylex.props(styles.navButton, motion.tint, focus.ring)}>
            Today
          </button>
          <button type="button" aria-label="Next day" onClick={() => go(addDays(anchor, 1))} {...stylex.props(styles.navButton, motion.tint, focus.ring)}>
            <ChevronRight size={16} aria-hidden="true" />
          </button>
        </div>
        <Button onClick={() => setScheduling({})}>
          <CalendarPlus size={16} aria-hidden="true" /> Schedule a meeting
        </Button>
      </div>

      <nav aria-label="Choose a date" {...stylex.props(styles.week)}>
        {days.map((day) => {
          const on = sameDay(day, anchor);
          const count = onDay(day).length;
          return (
            <Link
              key={day.toDateString()}
              to="/calendar"
              search={{ date: toDateParam(day) }}
              aria-current={on ? "date" : undefined}
              aria-label={`${day.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}, ${count} ${count === 1 ? "meeting" : "meetings"}`}
              {...stylex.props(styles.day, motion.tint, focus.ring, on && styles.dayOn)}
            >
              <span {...stylex.props(styles.dow)}>{day.toLocaleDateString([], { weekday: "short" })}</span>
              <span {...stylex.props(styles.num)}>{day.getDate()}</span>
              <span {...stylex.props(styles.count)}>{count > 0 ? count : ""}</span>
            </Link>
          );
        })}
      </nav>

      {shown.length > 0 ? (
        <ul aria-label="Meetings on this date" {...stylex.props(styles.list)}>
          {shown.map((event) => (
            <EventRow key={event.id} event={event} onEdit={(schedule) => setScheduling({ schedule })} onCancel={setCanceling} />
          ))}
        </ul>
      ) : (
        <p {...stylex.props(styles.empty)}>No meetings on this date.</p>
      )}

      <ScheduleMeetingDialog
        open={scheduling !== null}
        onOpenChange={(open) => !open && setScheduling(null)}
        schedule={scheduling?.schedule ?? null}
        initialStartsAt={sameDay(anchor, today) ? undefined : new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate(), 9).toISOString()}
      />
      <CancelScheduledMeetingDialog
        schedule={canceling}
        open={canceling !== null}
        onOpenChange={(open) => !open && setCanceling(null)}
      />
    </div>
  );
}
