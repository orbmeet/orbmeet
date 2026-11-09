import { getRouteApi, Link, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { useInfiniteQuery, useSuspenseQuery } from "@tanstack/react-query";
import { Check, Copy, Plus, Presentation, Settings2, Video } from "lucide-react";
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
import { MeetingBoardPreview } from "@/modules/meetings/client/components/meeting-board-preview";
import { formatMeetingDate, formatMeetingLength, meetingDisplayTitle } from "@/modules/meetings/client/components/meeting-format";
import { MeetingOutputActions } from "@/modules/meetings/client/components/meeting-output-actions";
import { isShortCall, MeetingRow, type MeetingRowData } from "@/modules/meetings/client/components/meeting-row";
import { JustEnded, Upcoming } from "@/pages/home/home-highlights";
import { enter } from "@orbmeet/ui/styles/animations";
import { focus, layout, motion, pressable, touch } from "@orbmeet/ui/styles/atoms";
import { accent, border, danger, ink, neutral, surface } from "@orbmeet/ui/tokens/colors.stylex";
import { bp, env } from "@orbmeet/ui/tokens/media.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { fonts, text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";

const routeApi = getRouteApi("/_authed/home/");

/** How many past meetings Home reads, enough to fill it once short calls are left out. */
const RECENT_FETCH = 12;
/** How many it lists under the latest one before handing over to the Library. */
const EARLIER_LIMIT = 4;

const styles = stylex.create({
  page: {
    maxWidth: 1100,
    marginInline: "auto",
    display: "flex",
    flexDirection: "column",
    gap: space.s8,
    paddingTop: { default: space.s4, [bp.lg]: space.s7 },
  },
  /** The greeting, and beside it the two things Home is for: start, or join. */
  top: { display: "flex", flexWrap: "wrap", alignItems: "flex-end", justifyContent: "space-between", columnGap: space.s8, rowGap: space.s5 },
  greeting: {
    margin: 0,
    fontFamily: fonts.heading,
    fontWeight: weight.semibold,
    fontSize: { default: "2rem", [bp.sm]: "2.5rem" },
    lineHeight: 1.05,
    letterSpacing: "-0.045em",
    color: ink.strong,
  },
  launch: { display: "flex", flexDirection: "column", gap: space.s2, flexGrow: 1, flexBasis: 420, maxWidth: 560 },
  actions: { display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: { default: "flex-start", [bp.xl]: "flex-end" }, gap: space.s2 },
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
  error: { margin: 0, fontSize: text.sm, color: danger.d700 },

  linkRow: { display: "flex", flexWrap: "wrap", alignItems: "center", columnGap: space.s4, rowGap: space.s2, paddingBlock: space.s3, paddingInline: space.s5 },
  linkLabel: { flexShrink: 0, width: { default: "100%", [bp.sm]: 168 }, fontSize: text.sm, fontWeight: weight.semibold, color: ink.strong },
  code: { flexGrow: 1, flexBasis: 200, minWidth: 0, fontFamily: fonts.mono, fontSize: text.sm, color: ink.strong },
  linkActions: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: space.s4 },
  textButton: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.s1,
    minHeight: 40,
    padding: 0,
    borderWidth: 0,
    cursor: "pointer",
    fontFamily: "inherit",
    fontSize: text.sm,
    fontWeight: weight.medium,
    textDecorationLine: "none",
    color: { default: accent.a700, [env.hoverable]: { default: accent.a700, ":hover": accent.a800 } },
    backgroundColor: "transparent",
  },

  latest: {
    position: "relative",
    display: "flex",
    flexWrap: "wrap",
    overflow: "hidden",
    borderRadius: 20,
    boxShadow: `0 0 0 1px ${border.subtle}`,
    backgroundColor: surface.raised,
  },
  latestOpen: { position: "absolute", inset: 0, zIndex: 0, borderRadius: 20 },
  latestThumb: {
    display: "grid",
    placeItems: "center",
    flexGrow: 1,
    flexBasis: 280,
    minHeight: 200,
    backgroundColor: surface.sunken,
    color: neutral.n400,
    overflow: "hidden",
  },
  latestBody: { display: "flex", flexDirection: "column", justifyContent: "center", gap: space.s2, flexGrow: 1, flexBasis: 340, minWidth: 0, padding: space.s6 },
  latestKicker: { margin: 0, fontSize: "0.8125rem", fontWeight: weight.semibold, color: accent.a700 },
  latestTitle: { margin: 0, fontFamily: fonts.heading, fontSize: "1.625rem", fontWeight: weight.semibold, lineHeight: 1.15, letterSpacing: "-0.03em", color: ink.strong },
  latestMeta: { margin: 0, fontSize: text.sm, color: ink.muted },
  latestActions: { position: "relative", zIndex: 1, alignSelf: "flex-start", paddingTop: space.s3 },

  recent: { display: "flex", flexDirection: "column", gap: space.s2 },
  sectionHead: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: space.s3 },
  sectionTitle: { margin: 0, fontSize: "0.9375rem", fontWeight: weight.semibold, color: ink.strong },
  sectionLink: { fontSize: "0.84375rem", fontWeight: weight.medium, color: accent.a700, textDecorationLine: "none" },
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

// ─── Your meeting link ───────────────────────────────────────────────────────

/** Your permanent link: a fact about you that people ask for, so copying it is one press. */
function MeetingLinkRow({ threads }: { threads: Thread[] }) {
  const router = useRouter();
  const [creatingLink, setCreatingLink] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { copied, copy } = useCopyToClipboard();
  const link = threads.find((thread) => thread.kind === "personal");

  return (
    <li {...stylex.props(styles.linkRow)}>
      <span {...stylex.props(styles.linkLabel)}>Your meeting link</span>
      {link ? (
        <>
          <span {...stylex.props(styles.code)}>{link.code}</span>
          <div {...stylex.props(styles.linkActions)}>
            <button
              type="button"
              onClick={() => void copy(`${window.location.origin}/${link.code}`)}
              {...stylex.props(styles.textButton, motion.tint, focus.ring)}
            >
              {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
              {copied ? "Copied" : "Copy link"}
            </button>
            <a
              href={`/${link.code}`}
              onClick={() => beginMeetingEntryFlow({ source: "home-join", code: link.code })}
              {...stylex.props(styles.textButton, motion.tint, focus.ring)}
            >
              <Video size={14} aria-hidden="true" />
              Start
            </a>
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              aria-label="Meeting link settings"
              {...stylex.props(styles.textButton, motion.tint, focus.ring)}
            >
              <Settings2 size={14} aria-hidden="true" />
              Settings
            </button>
          </div>
          <RoomLinkSettings thread={link} open={settingsOpen} onOpenChange={setSettingsOpen} />
        </>
      ) : (
        <button
          type="button"
          onClick={() => {
            preloadMeetingRoute(router).catch(() => {});
            setCreatingLink(true);
          }}
          {...stylex.props(styles.textButton, motion.tint, focus.ring)}
        >
          Make a meeting link
        </button>
      )}
      <CreatePersonalMeetingLinkDialog open={creatingLink} onOpenChange={setCreatingLink} />
    </li>
  );
}

// ─── Recent ──────────────────────────────────────────────────────────────────

/** The meeting you are most likely to come back for, with what it left. */
function Latest({ meeting, viewerName }: { meeting: MeetingRowData; viewerName: string }) {
  const title = meetingDisplayTitle(meeting.title, meeting.participantNames, viewerName);
  const others = meeting.participantNames.filter((name) => name !== viewerName);
  const details = [
    formatMeetingDate(meeting.startedAt),
    formatMeetingLength(meeting.startedAt, meeting.endedAt),
    others.length > 0 ? `with ${others.join(", ")}` : null,
  ].filter(Boolean);

  return (
    <section aria-labelledby="home-latest" {...stylex.props(styles.latest, enter.fadeUp)}>
      <Link
        to="/meetings/$meetingId"
        params={{ meetingId: meeting.meetingId }}
        aria-label={`Open ${title}`}
        {...stylex.props(styles.latestOpen, focus.ring)}
      />
      <span aria-hidden="true" {...stylex.props(styles.latestThumb)}>
        {meeting.hasWhiteboard ? (
          <MeetingBoardPreview meetingId={meeting.meetingId} fallback={<Presentation size={36} strokeWidth={1.4} />} />
        ) : (
          <Video size={36} strokeWidth={1.4} />
        )}
      </span>
      <div {...stylex.props(styles.latestBody)}>
        <p {...stylex.props(styles.latestKicker)}>Latest meeting</p>
        <h2 id="home-latest" {...stylex.props(styles.latestTitle, layout.truncate)}>{title}</h2>
        <p {...stylex.props(styles.latestMeta)}>{details.join(" · ")}</p>
        <div {...stylex.props(styles.latestActions)}>
          <MeetingOutputActions meeting={meeting} title={title} />
        </div>
      </div>
    </section>
  );
}

function Recent({ viewerName }: { viewerName: string }) {
  // Must never hold up starting or joining, so it does not suspend.
  const query = useInfiniteQuery(myMeetingsQueryOptions({ status: "ended", limit: RECENT_FETCH }));
  const meetings: MeetingRowData[] = (query.data?.pages[0]?.meetings ?? [])
    .map((meeting) => ({ ...meeting, hasWhiteboard: meeting.hasWhiteboardState || meeting.hasWhiteboardPdf }))
    .filter((meeting) => !isShortCall(meeting));
  const [latest, ...rest] = meetings;
  const earlier = rest.slice(0, EARLIER_LIMIT);

  if (query.isPending) return <p {...stylex.props(styles.quiet)}>Loading your meetings…</p>;
  if (query.isError) return <p {...stylex.props(styles.quiet)}>Your recent meetings couldn’t load. They’re all in the Library.</p>;
  if (!latest) return <p {...stylex.props(styles.quiet)}>Nothing yet. Meetings you have will show up here.</p>;

  return (
    <>
      <Latest meeting={latest} viewerName={viewerName} />
      {earlier.length > 0 ? (
        <section aria-labelledby="home-recent" {...stylex.props(styles.recent)}>
          <div {...stylex.props(styles.sectionHead)}>
            <h2 id="home-recent" {...stylex.props(styles.sectionTitle)}>Earlier</h2>
            <Link to="/library" {...stylex.props(touch.target, styles.sectionLink, focus.ring)}>All meetings</Link>
          </div>
          {earlier.map((meeting) => (
            <MeetingRow key={meeting.meetingId} meeting={meeting} viewerName={viewerName} />
          ))}
        </section>
      ) : null}
    </>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export function HomePage() {
  const { session: initialSession } = routeApi.useRouteContext();
  const session = useAuthenticatedSession(initialSession);
  const { left } = routeApi.useSearch();
  const navigate = routeApi.useNavigate();
  const name = session.user.name ?? "";
  const firstName = name.split(" ")[0] || "there";
  const [greeting] = useState(() => (typeof window === "undefined" ? "Welcome" : getGreeting(new Date().getHours())));

  const { data: threadsData } = useSuspenseQuery(myThreadsQueryOptions());
  const threads = threadsData.threads;
  const now = useNow(30_000, true);

  return (
    <div {...stylex.props(styles.page)}>
      <div {...stylex.props(styles.top)}>
        <h1 {...stylex.props(styles.greeting, enter.fadeUp)}>
          {greeting}, {firstName}.
        </h1>
        <Launch />
      </div>
      {left ? (
        <JustEnded
          meetingId={left}
          viewerName={name}
          onDismiss={() => void navigate({ search: {}, replace: true })}
        />
      ) : null}
      <Upcoming threads={threads} now={now}>
        <MeetingLinkRow threads={threads} />
      </Upcoming>
      <Recent viewerName={name} />
    </div>
  );
}
