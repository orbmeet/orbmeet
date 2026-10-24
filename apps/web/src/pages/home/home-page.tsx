import { getRouteApi, Link, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { useInfiniteQuery, useSuspenseQuery } from "@tanstack/react-query";
import { Check, Copy, Plus, Settings2 } from "lucide-react";
import {
  EXAMPLE_MEETING_CODE,
  MEETING_CODE_REGEX as CODE_REGEX,
} from "@/modules/meetings/contract/constants";
import { getErrorMessage } from "@/lib/error-inspection";
import { beginMeetingEntryFlow } from "@/modules/meetings/client/entry-metrics";
import { readCodeInput } from "@/modules/meetings/client/format-code";
import { preloadMeetingRoute } from "@/modules/meetings/client/preload-route";
import { useInstantMeeting } from "@/modules/meetings/client/use-instant-meeting";
import { useCopyToClipboard } from "@/lib/hooks/use-copy-to-clipboard";
import { useNow } from "@/lib/hooks/use-now";
import { useAuthenticatedSession } from "@/app/query-client/use-authenticated-session";
import { myMeetingsQueryOptions, myThreadsQueryOptions } from "@/app/query-client/queries/meetings";
import type { Thread } from "@/modules/meetings/contract/threads";
import { Spinner } from "@orbmeet/ui/react";
import { CreatePersonalMeetingLinkDialog } from "@/modules/meetings/client/dashboard/create-personal-meeting-link-dialog";
import { RoomLinkSettings } from "@/modules/meetings/client/components/links/room-link-settings";
import { groupMeetingsByDay, MeetingRow } from "@/modules/meetings/client/components/meeting-row";
import { StillToDo, Today } from "@/pages/home/home-highlights";
import { enter } from "@orbmeet/ui/styles/animations";
import { focus, motion, pressable, touch } from "@orbmeet/ui/styles/atoms";
import { accent, border, danger, ink, neutral, surface } from "@orbmeet/ui/tokens/colors.stylex";
import { bp, env } from "@orbmeet/ui/tokens/media.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { fonts, text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";

const routeApi = getRouteApi("/_authed/home/");

/** How many past meetings Home shows before handing over to the Library. */
const RECENT_LIMIT = 6;

const styles = stylex.create({
  page: {
    maxWidth: 1100,
    marginInline: "auto",
    display: "flex",
    flexDirection: "column",
    gap: space.s9,
    paddingTop: { default: space.s4, [bp.lg]: space.s7 },
  },
  /** The greeting, and beside it the two things Home is for: start, or join. */
  top: { display: "flex", flexWrap: "wrap", alignItems: "flex-end", justifyContent: "space-between", columnGap: space.s8, rowGap: space.s5 },
  header: { display: "flex", flexDirection: "column", gap: space.s1_5 },
  date: { fontFamily: fonts.mono, fontSize: "0.78125rem", letterSpacing: "0.02em", color: ink.muted },
  greeting: {
    margin: 0,
    fontFamily: fonts.heading,
    fontWeight: weight.semibold,
    fontSize: { default: "2rem", [bp.sm]: "2.5rem" },
    lineHeight: 1.05,
    letterSpacing: "-0.045em",
    color: ink.strong,
  },

  /**
   * Start and join sit straight on the page, under the greeting. The page is
   * already the frame: a box around them read as a room inside the room.
   */
  launch: { display: "flex", flexDirection: "column", gap: space.s2, flexGrow: 1, flexBasis: 420, maxWidth: 560 },
  actions: { display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: { default: "flex-start", [bp.lg]: "flex-end" }, gap: space.s2 },
  start: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.s2_5,
    height: 44,
    paddingInlineStart: space.s4,
    paddingInlineEnd: space.s5,
    borderWidth: 0,
    borderRadius: 999,
    cursor: "pointer",
    fontSize: text.sm,
    fontWeight: weight.medium,
    // The page's one violet button: the thing Home is for.
    color: ink.onAccent,
    backgroundColor: { default: accent.a600, [env.hoverable]: { default: accent.a600, ":hover:not(:disabled)": accent.a700 } },
    opacity: { default: 1, ":disabled": 0.7 },
  },
  join: {
    display: "flex",
    alignItems: "center",
    gap: space.s1,
    flexGrow: 1,
    flexBasis: 240,
    // Beside New meeting it stays a field's width; on its own line it fills it.
    maxWidth: { default: "none", [bp.lg]: 340 },
    minWidth: 0,
    height: 44,
    margin: 0,
    boxSizing: "border-box",
    paddingInlineStart: space.s4,
    paddingInlineEnd: 4,
    borderWidth: 1,
    borderStyle: "solid",
    borderRadius: 999,
    backgroundColor: surface.raised,
    // The field has no ring of its own: the pill around it lights up instead.
    boxShadow: { default: "none", ":focus-within": `0 0 0 3px ${accent.a200}` },
    borderColor: { default: border.base, ":focus-within": accent.a500 },
  },
  joinInput: {
    flexGrow: 1,
    minWidth: 0,
    height: "100%",
    padding: 0,
    borderWidth: 0,
    outline: "none",
    // 16px under a finger: iOS zooms into a smaller focused field.
    fontSize: text.base,
    color: ink.strong,
    backgroundColor: surface.raised,
    "::placeholder": { color: neutral.n400 },
  },
  joinButton: {
    height: 36,
    paddingInline: space.s4,
    borderWidth: 0,
    borderRadius: 999,
    cursor: "pointer",
    fontSize: text.sm,
    fontWeight: weight.medium,
    color: ink.strong,
    backgroundColor: { default: neutral.n100, [env.hoverable]: { default: neutral.n100, ":hover": neutral.n150 } },
  },
  code: { fontFamily: fonts.mono, fontSize: text.base, fontWeight: weight.medium, color: ink.strong },
  textButton: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.s1,
    minHeight: 32,
    padding: 0,
    borderWidth: 0,
    cursor: "pointer",
    fontSize: text.sm,
    fontWeight: weight.medium,
    color: { default: accent.a700, [env.hoverable]: { default: accent.a700, ":hover": accent.a800 } },
    backgroundColor: "transparent",
  },
  error: { margin: 0, fontSize: text.sm, color: danger.d700 },

  /**
   * Today and Earlier, with the to-dos and your room beside them. In one
   * column the side comes between the two, so your room is not pushed under
   * the whole of your history.
   */
  body: {
    display: "grid",
    gridTemplateColumns: { default: "minmax(0, 1fr)", [bp.xl]: "minmax(0, 1fr) minmax(260px, 300px)" },
    gridTemplateRows: { default: null, [bp.xl]: "auto 1fr" },
    gridTemplateAreas: { default: '"today" "aside" "recent"', [bp.xl]: '"today aside" "recent aside"' },
    alignItems: "start",
    columnGap: space.s10,
    rowGap: space.s9,
  },
  // Placed by the named areas above; the start and end lines name an area's edges.
  areaToday: { gridRowStart: "today", gridRowEnd: "today", gridColumnStart: "today", gridColumnEnd: "today", minWidth: 0 },
  areaRecent: { gridRowStart: "recent", gridRowEnd: "recent", gridColumnStart: "recent", gridColumnEnd: "recent", minWidth: 0 },
  recent: { display: "flex", flexDirection: "column", gap: space.s2 },
  aside: { gridRowStart: "aside", gridRowEnd: "aside", gridColumnStart: "aside", gridColumnEnd: "aside", display: "flex", flexDirection: "column", gap: space.s8, minWidth: 0 },
  roomCard: {
    display: "flex",
    flexDirection: "column",
    gap: space.s2,
    padding: space.s5,
    borderRadius: 16,
    backgroundColor: surface.sunken,
  },
  roomLabel: { margin: 0, fontSize: "0.8125rem", fontWeight: weight.normal, color: ink.muted },
  roomActions: { display: "flex", flexWrap: "wrap", gap: space.s4 },
  sectionHead: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: space.s3 },
  sectionTitle: { margin: 0, fontSize: "0.9375rem", fontWeight: weight.semibold, color: ink.strong },
  sectionLink: { fontSize: "0.84375rem", fontWeight: weight.medium, color: accent.a700, textDecorationLine: "none" },
  day: { display: "flex", flexDirection: "column", gap: space.s0_5, paddingTop: space.s3_5 },
  dayHead: { display: "flex", alignItems: "baseline", gap: space.s2, paddingBottom: space.s1_5 },
  dayLabel: { fontSize: "0.8125rem", fontWeight: weight.semibold, color: ink.strong },
  dayDate: { fontFamily: fonts.mono, fontSize: text.xs, color: ink.muted },
  quiet: { margin: 0, paddingBlock: space.s4, fontSize: text.sm, color: ink.muted },

});

function getGreeting(hour: number): string {
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}


// ─── Start or join ───────────────────────────────────────────────────────────

/**
 * The one decision Home asks of you: start, or join, side by side in the
 * header. A code and a link are the same thing here; either is pasted.
 */
function Launch() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [joinError, setJoinError] = useState("");
  const [startError, setStartError] = useState("");

  const warm = () => {
    preloadMeetingRoute(router).catch(() => {});
  };
  const instantMeeting = useInstantMeeting({
    onError: (error) => setStartError(getErrorMessage(error, "Couldn’t start the meeting. Please try again.")),
  });

  function handleJoin(event: React.FormEvent) {
    event.preventDefault();
    setJoinError("");
    if (!CODE_REGEX.test(code)) {
      setJoinError(`Enter a code like ${EXAMPLE_MEETING_CODE}, or paste the meeting’s link.`);
      return;
    }
    beginMeetingEntryFlow({ source: "home-join", code });
    window.location.href = `/${code}`;
  }

  return (
    <section aria-label="Start or join a meeting" {...stylex.props(styles.launch, enter.fadeUp)}>
      <div {...stylex.props(styles.actions)}>
        <button
          type="button"
          onClick={() => {
            warm();
            setStartError("");
            if (!instantMeeting.isPending) instantMeeting.mutate();
          }}
          onPointerEnter={warm}
          disabled={instantMeeting.isPending}
          aria-busy={instantMeeting.isPending}
          {...stylex.props(pressable.base, pressable.sink, motion.tint, focus.ring, styles.start)}
        >
          {instantMeeting.isPending ? <Spinner size="sm" /> : <Plus size={17} strokeWidth={2.2} aria-hidden="true" />}
          New meeting
        </button>
        <form onSubmit={handleJoin} {...stylex.props(styles.join)}>
          <input
            id="meeting-code"
            aria-label="Meeting code or link"
            value={code}
            onChange={(event) => {
              setJoinError("");
              setCode(readCodeInput(event.target.value));
            }}
            onFocus={warm}
            placeholder="Code or link"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            aria-invalid={Boolean(joinError)}
            aria-describedby={joinError ? "meeting-code-error" : undefined}
            {...stylex.props(styles.joinInput)}
          />
          <button type="submit" onPointerEnter={warm} {...stylex.props(styles.joinButton, motion.tint, focus.ring)}>
            Join
          </button>
        </form>
      </div>
      {startError ? <p role="alert" {...stylex.props(styles.error)}>{startError}</p> : null}
      {joinError ? (
        <p role="alert" id="meeting-code-error" {...stylex.props(styles.error)}>{joinError}</p>
      ) : null}
    </section>
  );
}

// ─── Your room ───────────────────────────────────────────────────────────────

/**
 * Your permanent link, as a small card beside the to-dos: a fact about you
 * that people ask for, so copying it is one press.
 */
function RoomCard({ threads }: { threads: Thread[] }) {
  const router = useRouter();
  const [creatingLink, setCreatingLink] = useState(false);
  const [roomSettingsOpen, setRoomSettingsOpen] = useState(false);
  const { copied, copy } = useCopyToClipboard();
  const room = threads.find((thread) => thread.kind === "personal");

  return (
    <section aria-labelledby="home-room" {...stylex.props(styles.roomCard, enter.fadeUp)}>
      <h2 id="home-room" {...stylex.props(styles.roomLabel)}>
        {room ? "Your room — the same link every time" : "Want one link people can always use?"}
      </h2>
      {room ? (
        <>
          <span {...stylex.props(styles.code)}>{room.code}</span>
          <div {...stylex.props(styles.roomActions)}>
            <button
              type="button"
              onClick={() => void copy(`${window.location.origin}/${room.code}`)}
              {...stylex.props(styles.textButton, motion.tint, focus.ring)}
            >
              {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
              {copied ? "Copied" : "Copy link"}
            </button>
            <button
              type="button"
              onClick={() => setRoomSettingsOpen(true)}
              {...stylex.props(styles.textButton, motion.tint, focus.ring)}
            >
              <Settings2 size={14} aria-hidden="true" />
              Room settings
            </button>
          </div>
          <RoomLinkSettings thread={room} open={roomSettingsOpen} onOpenChange={setRoomSettingsOpen} />
        </>
      ) : (
        <div {...stylex.props(styles.roomActions)}>
          <button
            type="button"
            onClick={() => {
              preloadMeetingRoute(router).catch(() => {});
              setCreatingLink(true);
            }}
            {...stylex.props(styles.textButton, motion.tint, focus.ring)}
          >
            Make a room link
          </button>
        </div>
      )}
      <CreatePersonalMeetingLinkDialog open={creatingLink} onOpenChange={setCreatingLink} />
    </section>
  );
}

// ─── Recent ──────────────────────────────────────────────────────────────────

function Recent({ viewerName }: { viewerName: string }) {
  // Must never hold up starting or joining, so it does not suspend.
  const query = useInfiniteQuery(myMeetingsQueryOptions({ status: "ended", limit: RECENT_LIMIT }));
  const meetings = (query.data?.pages[0]?.meetings ?? []).slice(0, RECENT_LIMIT).map((meeting) => ({
    ...meeting,
    hasWhiteboard: meeting.hasWhiteboardState || meeting.hasWhiteboardPdf,
  }));
  const days = groupMeetingsByDay(meetings);

  return (
    <section aria-labelledby="home-recent" {...stylex.props(styles.recent)}>
      <div {...stylex.props(styles.sectionHead)}>
        <h2 id="home-recent" {...stylex.props(styles.sectionTitle)}>Earlier</h2>
        <Link to="/library" {...stylex.props(touch.target, styles.sectionLink, focus.ring)}>Open library</Link>
      </div>
      {query.isPending ? (
        <p {...stylex.props(styles.quiet)}>Loading your meetings…</p>
      ) : query.isError ? (
        <p {...stylex.props(styles.quiet)}>Your recent meetings couldn’t load. They’re all in the Library.</p>
      ) : days.length === 0 ? (
        <p {...stylex.props(styles.quiet)}>
          Nothing yet. Meetings you have, with their boards and recaps, will show up here.
        </p>
      ) : (
        days.map((day) => (
          <div key={day.key} {...stylex.props(styles.day)}>
            <div {...stylex.props(styles.dayHead)}>
              <span {...stylex.props(styles.dayLabel)}>{day.label}</span>
              <span {...stylex.props(styles.dayDate)}>{day.date}</span>
            </div>
            {day.meetings.map((meeting) => (
              <MeetingRow key={meeting.meetingId} meeting={meeting} viewerName={viewerName} />
            ))}
          </div>
        ))
      )}
    </section>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export function HomePage() {
  const { session: initialSession } = routeApi.useRouteContext();
  const session = useAuthenticatedSession(initialSession);
  const name = session.user.name ?? "";
  const firstName = name.split(" ")[0] || "there";
  const [{ greeting, date }] = useState(() => {
    if (typeof window === "undefined") return { greeting: "Welcome", date: "" };
    const now = new Date();
    return {
      greeting: getGreeting(now.getHours()),
      date: now.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" }),
    };
  });

  const { data: threadsData } = useSuspenseQuery(myThreadsQueryOptions());
  const threads = threadsData.threads;
  const hasLive = threads.some((thread) => (thread.openMeeting?.participantCount ?? 0) > 0);
  const now = useNow(30_000, hasLive);

  return (
    <div {...stylex.props(styles.page)}>
      <div {...stylex.props(styles.top)}>
        <header {...stylex.props(styles.header, enter.fadeUp)}>
          {date ? <span {...stylex.props(styles.date)}>{date}</span> : null}
          <h1 {...stylex.props(styles.greeting)}>
            {greeting}, {firstName}.
          </h1>
        </header>
        <Launch />
      </div>
      <div {...stylex.props(styles.body)}>
        <div {...stylex.props(styles.areaToday)}>
          <Today threads={threads} now={now} />
        </div>
        <div {...stylex.props(styles.areaRecent)}>
          <Recent viewerName={name} />
        </div>
        <aside aria-label="Still to do, and your room" {...stylex.props(styles.aside)}>
          <StillToDo />
          <RoomCard threads={threads} />
        </aside>
      </div>
    </div>
  );
}
