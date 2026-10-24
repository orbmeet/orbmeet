import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { CalendarPlus, ChevronLeft, ChevronRight } from "lucide-react";
import { myMeetingsQueryOptions, myUpcomingMeetingSchedulesQueryOptions } from "@/app/query-client/queries/meetings";
import { useAuthenticatedSession } from "@/app/query-client/use-authenticated-session";
import { meetingDisplayTitle } from "@/modules/meetings/client/components/meeting-format";
import { UpcomingMeetings } from "@/modules/scheduling/client/upcoming-meetings";
import { ScheduleMeetingDialog, type UpcomingMeetingSchedule } from "@/modules/scheduling/client/schedule-meeting-dialog";
import { useNow } from "@/lib/hooks/use-now";
import { useResponsive } from "@/lib/hooks/use-responsive";
import { Button } from "@orbmeet/ui/react";
import { enter } from "@orbmeet/ui/styles/animations";
import { focus, layout, motion } from "@orbmeet/ui/styles/atoms";
import { accent, border, danger, ink, live, neutral, surface } from "@orbmeet/ui/tokens/colors.stylex";
import { bp, env } from "@orbmeet/ui/tokens/media.stylex";
import { shadows } from "@orbmeet/ui/tokens/shadows.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { fonts, text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";
import { addDays, fromDateParam, openingHour, placeDay, sameDay, startOfWeek, toDateParam } from "./calendar-week";
import { EventDetail, type CalendarEvent, type EventKind } from "./event-detail";

const routeApi = getRouteApi("/_authed/calendar/");

/** One hour of the grid, in px. */
const HOUR = 52;
/** The grid opens scrolled to this hour, a working morning. */
const FIRST_VISIBLE_HOUR = 7;
/** The hour labels' column, in px. */
const GUTTER = 56;
/**
 * The least an event is drawn as, in minutes of grid. A finger needs a taller
 * block to hit than a pointer does; it is reserved in the layout too, so a
 * short call never sits on top of the next one.
 */
const MIN_EVENT_MINUTES = { pointer: 20, touch: 40 };
/**
 * The least block height, in px, that holds an event's time under its title:
 * 4px padding each end, a 15px title, a 1px gap, a 13px time, and a planned
 * event's 1.5px border each end. Under it the time is read out but not drawn,
 * rather than drawn cut in half, as a 40-minute touch block (33px) drew it.
 */
const EVENT_TIME_FITS_PX = 41;

const styles = stylex.create({
  page: { display: "flex", flexDirection: "column", gap: space.s5, paddingTop: { default: space.s4, [bp.lg]: space.s6 } },
  /**
   * The week fits the window on a desktop: the page is the window less the
   * shell's `<main>` chrome around it (its 12px margins, 1px border, s4 top and
   * s16 bottom padding — see authed-layout), and the grid takes what the bar
   * leaves, one line or wrapped. A `100vh - 190px` grid guessed at the bar and
   * missed by 8px, scrolling the whole page under the grid's own scroll.
   */
  pageFitsWindow: {
    height: {
      default: "auto",
      [bp.lg]: `calc(100dvh - 2 * ${space.s3} - 2px - ${space.s4} - ${space.s16})`,
    },
    boxSizing: "border-box",
  },
  bar: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: space.s3 },
  title: {
    margin: 0,
    marginInlineEnd: space.s2,
    fontFamily: fonts.heading,
    fontWeight: weight.semibold,
    fontSize: { default: "1.75rem", [bp.sm]: "2rem" },
    letterSpacing: "-0.04em",
    color: ink.strong,
  },
  nav: { display: "flex", gap: space.s1 },
  navButton: {
    display: "grid",
    placeItems: "center",
    minWidth: 36,
    height: 36,
    paddingInline: space.s2_5,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: border.subtle,
    borderRadius: 10,
    fontSize: "0.84375rem",
    fontWeight: weight.medium,
    color: ink.strong,
    textDecorationLine: "none",
    backgroundColor: { default: surface.raised, [env.hoverable]: { default: surface.raised, ":hover": neutral.n50 } },
  },
  zone: { fontSize: "0.8125rem", color: ink.muted },
  spacer: { flexGrow: 1 },
  views: { display: "flex", padding: 3, borderRadius: 11, backgroundColor: neutral.n100 },
  viewLink: {
    display: "inline-flex",
    alignItems: "center",
    height: { default: 30, [env.touch]: 38 },
    paddingInline: space.s3,
    borderRadius: 8,
    fontSize: "0.84375rem",
    color: ink.body,
    textDecorationLine: "none",
  },
  viewOn: { fontWeight: weight.medium, color: ink.strong, backgroundColor: surface.raised, boxShadow: shadows.hairline },

  /** The week, and beside it the meeting you picked. Stacked on a narrow screen. */
  split: { display: "flex", flexWrap: "wrap", alignItems: "flex-start", gap: space.s6 },
  splitFills: { flexGrow: { default: 0, [bp.lg]: 1 }, minHeight: 0 },
  detail: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 300,
    maxWidth: { default: "none", [bp.xl]: 340 },
    minWidth: 0,
    boxSizing: "border-box",
    padding: space.s6,
    borderRadius: 18,
    backgroundColor: surface.sunken,
  },
  detailEmpty: { margin: 0, fontSize: text.sm, lineHeight: 1.5, color: ink.muted },
  scroller: {
    flexGrow: 999,
    flexShrink: 1,
    flexBasis: 640,
    minWidth: 0,
    overflow: "auto",
    maxHeight: { default: "70vh", [bp.lg]: "100%" },
    minHeight: 420,
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: border.subtle,
  },
  grid: { display: "grid", minWidth: 680 },
  gridDay: { minWidth: 0 },
  head: {
    position: "sticky",
    top: 0,
    zIndex: 3,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: space.s1,
    paddingBlock: space.s2_5,
    backgroundColor: surface.raised,
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: border.subtle,
  },
  // The corner stays put both ways, above the day heads and the hour gutter.
  headCorner: { position: "sticky", top: 0, insetInlineStart: 0, zIndex: 4, backgroundColor: surface.raised, borderBottomWidth: 1, borderBottomStyle: "solid", borderBottomColor: border.subtle },
  dow: { fontSize: text.xs, fontWeight: weight.medium, color: ink.muted },
  num: { display: "grid", placeItems: "center", width: 32, height: 32, borderRadius: "50%", fontSize: "0.9375rem", fontWeight: weight.semibold, color: ink.strong },
  numToday: { color: ink.onAccent, backgroundColor: accent.a600 },
  // A week scrolled sideways on a narrow screen keeps its hours in view.
  gutter: { position: "sticky", insetInlineStart: 0, zIndex: 2, height: HOUR * 24, backgroundColor: surface.raised },
  hour: {
    position: "absolute",
    insetInlineEnd: space.s2_5,
    transform: "translateY(-50%)",
    fontFamily: fonts.mono,
    fontSize: "0.6875rem",
    color: ink.muted,
  },
  column: {
    position: "relative",
    borderInlineStartWidth: 1,
    borderInlineStartStyle: "solid",
    borderInlineStartColor: border.subtle,
    height: HOUR * 24,
    backgroundImage: `repeating-linear-gradient(to bottom, ${neutral.n100} 0, ${neutral.n100} 1px, transparent 1px, transparent ${HOUR}px)`,
  },
  /**
   * An empty hour of a day, to schedule in. Out of the tab order: 168 stops
   * would bury the grid's events, and the Schedule button does the same job
   * from the keyboard.
   */
  slot: {
    position: "absolute",
    insetInline: 0,
    height: HOUR,
    padding: 0,
    borderWidth: 0,
    cursor: "copy",
    backgroundColor: { default: "transparent", [env.hoverable]: { default: "transparent", ":hover": neutral.n50 } },
  },
  columnWeekend: { backgroundColor: surface.sunken },
  columnToday: { backgroundColor: accent.a50 },
  event: {
    position: "absolute",
    display: "flex",
    flexDirection: "column",
    gap: 1,
    overflow: "hidden",
    boxSizing: "border-box",
    paddingInline: 7,
    paddingBlock: 4,
    borderWidth: 0,
    borderRadius: 8,
    cursor: "pointer",
    textAlign: "start",
    fontFamily: "inherit",
    fontSize: text.xs,
    lineHeight: 1.25,
    textDecorationLine: "none",
    transitionProperty: { default: "transform, box-shadow, opacity", [env.reducedMotion]: "none" },
    transitionDuration: "180ms",
    transform: { default: "none", [env.hoverable]: { default: "none", ":hover": "translateY(-1px)" } },
  },
  // What is over steps back; what is on and what is coming stand out.
  past: { color: ink.body, backgroundColor: neutral.n100, opacity: 0.75 },
  pastSpace: { color: accent.a800, backgroundColor: accent.a100, opacity: 0.75 },
  live: { color: live.l800, backgroundColor: live.l100, boxShadow: `inset 0 0 0 1.5px ${live.l500}` },
  selected: { opacity: 1, boxShadow: `0 0 0 2px ${surface.raised}, 0 0 0 4px ${accent.a500}`, zIndex: 1 },
  planned: {
    color: accent.a700,
    backgroundColor: accent.a50,
    borderWidth: 1.5,
    borderStyle: "dashed",
    borderColor: accent.a400,
  },
  eventTitle: { flexShrink: 0, fontWeight: weight.semibold },
  // The time gives way first: a short block shows its name, not its clock
  // (`EVENT_TIME_FITS_PX`). It keeps to one line, cut short, where a narrow
  // lane would wrap it a word a line.
  eventTime: {
    minHeight: 0,
    overflow: "hidden",
    whiteSpace: "nowrap",
    textOverflow: "ellipsis",
    fontFamily: fonts.mono,
    fontSize: "0.65625rem",
    opacity: 0.85,
  },
  now: { position: "absolute", insetInline: 0, height: 2, backgroundColor: danger.d600, pointerEvents: "none" },
  nowDot: { position: "absolute", insetInlineStart: -5, top: -4, width: 10, height: 10, borderRadius: "50%", backgroundColor: danger.d600 },
});

/** Where things sit in the grid: worked out per item, so set as dynamic styles. */
const placement = stylex.create({
  columns: (columns: string) => ({ gridTemplateColumns: columns }),
  top: (top: string) => ({ top }),
  block: (top: string, height: string, start: string, width: string) => ({ top, height, insetInlineStart: start, width }),
});

const eventStyle: Record<EventKind, stylex.StyleXStyles> = {
  past: styles.past,
  pastSpace: styles.pastSpace,
  live: styles.live,
  planned: styles.planned,
};

function isWeekend(day: Date): boolean {
  return day.getDay() === 0 || day.getDay() === 6;
}

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
      events.push({
        id: `m:${meeting.id}`,
        title: meetingDisplayTitle(meeting.title, meeting.participantNames, viewerName),
        start,
        end: new Date(meeting.endedAt ?? meeting.startedAt),
        kind: meeting.spaceName ? "pastSpace" : "past",
        meetingId: meeting.id,
        spaceId: meeting.spaceId,
        spaceName: meeting.spaceName,
        participantNames: meeting.participantNames,
      });
    }
    for (const meeting of open.data?.pages.flatMap((page) => page.meetings) ?? []) {
      if (!meeting.startedAt) continue;
      events.push({
        id: `m:${meeting.id}`,
        title: meeting.title || meeting.spaceName || "Meeting",
        start: new Date(meeting.startedAt),
        end: new Date(Math.max(now, Date.parse(meeting.startedAt))),
        kind: "live",
        code: meeting.code,
        spaceId: meeting.spaceId,
        spaceName: meeting.spaceName,
        participantNames: meeting.participantNames,
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
        kind: "planned",
        spaceId: schedule.spaceId,
        spaceName: schedule.spaceName,
        schedule,
      });
    }
    return events;
  }, [past.data, open.data, planned.data, from, to, now, viewerName]);
}

function DayColumn({
  day,
  today,
  now,
  events,
  selectedId,
  minMinutes,
  onPick,
  onSelect,
}: {
  day: Date;
  today: boolean;
  now: number;
  events: CalendarEvent[];
  selectedId: string | null;
  minMinutes: number;
  onPick: (at: Date) => void;
  onSelect: (id: string) => void;
}) {
  const placed = placeDay(events, day, minMinutes);
  const nowMinute = (now - new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime()) / 60_000;
  const dayLabel = day.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
  return (
    <div {...stylex.props(styles.column, isWeekend(day) && styles.columnWeekend, today && styles.columnToday)}>
      {/* An empty stretch of the day is a time to schedule at, to the quarter hour. */}
      {Array.from({ length: 24 }, (_, hour) => (
        <button
          key={hour}
          type="button"
          tabIndex={-1}
          aria-label={`Schedule ${dayLabel} at ${new Date(2000, 0, 1, hour).toLocaleTimeString([], { hour: "numeric" })}`}
          onClick={(event) => {
            const quarter = Math.min(3, Math.floor((event.nativeEvent.offsetY / HOUR) * 4));
            onPick(new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, quarter * 15));
          }}
          {...stylex.props(styles.slot, placement.top(`${hour * HOUR}px`))}
        />
      ))}
      {placed.map(({ item, fromMinute, toMinute, lane, lanes }) => {
        const heightPx = Math.max(20, ((toMinute - fromMinute) / 60) * HOUR - 2);
        const block = placement.block(
          `${(fromMinute / 60) * HOUR}px`,
          `${heightPx}px`,
          `calc(${(lane / lanes) * 100}% + 3px)`,
          `calc(${100 / lanes}% - 6px)`,
        );
        const body = (
          <>
            <span {...stylex.props(styles.eventTitle, layout.truncate)}>{item.title}</span>
            {/* Out of sight on a short block, but still part of its name. */}
            <span {...stylex.props(heightPx >= EVENT_TIME_FITS_PX ? styles.eventTime : layout.srOnly)}>
              {shortTime(item.start)}
              {item.kind === "live" ? " · now" : `–${shortTime(item.end)}`}
            </span>
          </>
        );
        const selected = item.id === selectedId;
        return (
          <button
            key={item.id}
            type="button"
            aria-pressed={selected}
            onClick={() => onSelect(item.id)}
            {...stylex.props(styles.event, eventStyle[item.kind], selected && styles.selected, block, motion.tint, focus.ring)}
          >
            {body}
          </button>
        );
      })}
      {today && nowMinute >= 0 && nowMinute < 24 * 60 ? (
        <span aria-hidden="true" {...stylex.props(styles.now, placement.top(`${(nowMinute / 60) * HOUR}px`))}>
          <span {...stylex.props(styles.nowDot)} />
        </span>
      ) : null}
    </div>
  );
}

export function CalendarPage() {
  const search = routeApi.useSearch();
  const navigate = useNavigate();
  const { session: initialSession } = getRouteApi("/_authed").useRouteContext();
  const session = useAuthenticatedSession(initialSession);
  const now = useNow(60_000, true);
  const today = new Date(now);
  // Midnight, not now: a day shown from now on would leave out what already happened today.
  const anchor = fromDateParam(search.date, new Date(today.getFullYear(), today.getMonth(), today.getDate()));
  const { isPhone } = useResponsive();
  const view = search.view ?? (isPhone ? "day" : "week");
  // Whether a finger points doesn't change while the page is open.
  const [coarse] = useState(() => window.matchMedia("(pointer: coarse)").matches);
  const days = view === "day" ? [anchor] : Array.from({ length: 7 }, (_, i) => addDays(startOfWeek(anchor), i));
  const events = useEvents(days, session.user.name ?? "", now);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const [scheduling, setScheduling] = useState<{ startsAt?: string; schedule?: UpcomingMeetingSchedule } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Nothing picked yet: what is on now, else the next thing still to come.
  const selected =
    events.find((event) => event.id === selectedId) ??
    events.find((event) => event.kind === "live") ??
    events
      .filter((event) => event.kind === "planned" && event.end.getTime() > now)
      .sort((a, b) => a.start.getTime() - b.start.getTime())[0] ??
    null;
  const scroller = useRef<HTMLDivElement>(null);
  const firstHour = openingHour(events, days, FIRST_VISIBLE_HOUR);
  useEffect(() => {
    // A little above the hour, so its label is read whole rather than cut by the header.
    if (scroller.current) scroller.current.scrollTop = firstHour * HOUR - 16;
  }, [view, firstHour]);
  const weekKey = days[0].toDateString();
  useEffect(() => {
    // A week wider than the screen opens on today rather than on Monday.
    const el = scroller.current;
    const head = el?.querySelector<HTMLElement>("[data-today]");
    if (!el) return;
    el.scrollLeft =
      head && el.scrollWidth > el.clientWidth
        ? head.getBoundingClientRect().left - el.getBoundingClientRect().left + el.scrollLeft - GUTTER
        : 0;
  }, [view, weekKey]);

  const step = view === "day" ? 1 : 7;
  const go = (date: Date | undefined) =>
    void navigate({ to: "/calendar", search: { view: search.view, date: date ? toDateParam(date) : undefined } });

  return (
    <div {...stylex.props(styles.page, view !== "agenda" && styles.pageFitsWindow, enter.fadeUp)}>
      <div {...stylex.props(styles.bar)}>
        <h1 {...stylex.props(styles.title)}>
          {anchor.toLocaleDateString([], { month: "long", year: "numeric" })}
        </h1>
        <div {...stylex.props(styles.nav)}>
          <button type="button" aria-label={view === "day" ? "Previous day" : "Previous week"} onClick={() => go(addDays(anchor, -step))} {...stylex.props(styles.navButton, motion.tint, focus.ring)}>
            <ChevronLeft size={16} aria-hidden="true" />
          </button>
          <button type="button" onClick={() => go(undefined)} {...stylex.props(styles.navButton, motion.tint, focus.ring)}>
            Today
          </button>
          <button type="button" aria-label={view === "day" ? "Next day" : "Next week"} onClick={() => go(addDays(anchor, step))} {...stylex.props(styles.navButton, motion.tint, focus.ring)}>
            <ChevronRight size={16} aria-hidden="true" />
          </button>
        </div>
        <span {...stylex.props(styles.zone)}>Times in {zone}</span>
        <span {...stylex.props(styles.spacer)} />
        <nav aria-label="Calendar view" {...stylex.props(styles.views)}>
          {([["day", "Day"], ["week", "Week"], ["agenda", "Agenda"]] as const).map(([value, label]) => (
            <Link
              key={label}
              to="/calendar"
              search={{ date: search.date, view: value }}
              aria-current={view === value ? "page" : undefined}
              {...stylex.props(styles.viewLink, motion.tint, focus.ring, view === value && styles.viewOn)}
            >
              {label}
            </Link>
          ))}
        </nav>
        <Button onClick={() => setScheduling({})}>
          <CalendarPlus size={16} aria-hidden="true" /> Schedule
        </Button>
      </div>

      {view === "agenda" ? (
        <UpcomingMeetings onSchedule={() => setScheduling({})} scheduleActionLabel="Schedule" />
      ) : (
        <div {...stylex.props(styles.split, styles.splitFills)}>
        <div ref={scroller} {...stylex.props(styles.scroller)}>
          <div {...stylex.props(styles.grid, view === "day" && styles.gridDay, placement.columns(`${GUTTER}px repeat(${days.length}, minmax(0, 1fr))`))}>
            <span {...stylex.props(styles.headCorner)} />
            {days.map((day) => (
              <div key={day.toDateString()} data-today={sameDay(day, today) || undefined} {...stylex.props(styles.head)}>
                <span {...stylex.props(styles.dow)}>{day.toLocaleDateString([], { weekday: "short" })}</span>
                <span {...stylex.props(styles.num, sameDay(day, today) && styles.numToday)}>{day.getDate()}</span>
              </div>
            ))}
            <div {...stylex.props(styles.gutter)} aria-hidden="true">
              {Array.from({ length: 23 }, (_, i) => i + 1).map((hour) => (
                <span key={hour} {...stylex.props(styles.hour, placement.top(`${hour * HOUR}px`))}>
                  {new Date(2000, 0, 1, hour).toLocaleTimeString([], { hour: "numeric" })}
                </span>
              ))}
            </div>
            {days.map((day) => (
              <DayColumn
                key={day.toDateString()}
                day={day}
                today={sameDay(day, today)}
                now={now}
                events={events}
                selectedId={selected?.id ?? null}
                minMinutes={coarse ? MIN_EVENT_MINUTES.touch : MIN_EVENT_MINUTES.pointer}
                onPick={(at) => setScheduling({ startsAt: at.toISOString() })}
                onSelect={setSelectedId}
              />
            ))}
          </div>
        </div>
        <aside aria-label="Selected meeting" {...stylex.props(styles.detail)}>
          {selected ? (
            <EventDetail event={selected} now={now} onEditSchedule={(schedule) => setScheduling({ schedule })} />
          ) : (
            <p {...stylex.props(styles.detailEmpty)}>Pick a meeting to see what it left, or what it picks up from last time.</p>
          )}
        </aside>
        </div>
      )}

      <ScheduleMeetingDialog
        open={scheduling !== null}
        onOpenChange={(open) => !open && setScheduling(null)}
        schedule={scheduling?.schedule ?? null}
        initialStartsAt={scheduling?.startsAt}
      />
    </div>
  );
}
