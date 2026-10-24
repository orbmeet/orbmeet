import { getRouteApi, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Plus, Presentation, Search, Video } from "lucide-react";
import { myMeetingsQueryOptions, mySpokenLinesQueryOptions } from "@/app/query-client/queries/meetings";
import { MIN_SPOKEN_SEARCH_LENGTH } from "@/modules/transcripts/server/spoken-search.functions";
import { mySpacesQueryOptions } from "@/app/query-client/queries/spaces";
import { myWhiteboardsQueryOptions } from "@/app/query-client/queries/whiteboards";
import { useAuthenticatedSession } from "@/app/query-client/use-authenticated-session";
import { QueryErrorNotice } from "@/app/query-client/query-error-notice";
import { sinceFor, toLibraryMeetingsInput, type LibrarySearch, type LibraryType } from "../../routes/_authed/library/index";
import { groupMeetingsByDay, MeetingRow } from "@/modules/meetings/client/components/meeting-row";
import { meetingDisplayTitle, formatMeetingDate } from "@/modules/meetings/client/components/meeting-format";
import { beginMeetingEntryFlow } from "@/modules/meetings/client/entry-metrics";
import { meetingEntryPath } from "@/modules/meetings/client/urls";
import { findMeetingCode } from "@/modules/meetings/client/format-code";
import { endMeeting } from "@/modules/meetings/server/runtime/live.functions";
import { EndMeetingDialog } from "@/modules/meetings/client/components/end-meeting-dialog";
import { boardDisplayTitle } from "@/modules/whiteboards/client/board-title";
import { ArchivedBoardRow } from "@/modules/whiteboards/client/components/archived-board-row";
import { NewWhiteboardDialog } from "@/modules/whiteboards/client/components/new-whiteboard-dialog";
import { List } from "@/app/shell/list";
import { formatActivityDay } from "@/modules/whiteboards/client/whiteboard-activity";
import { getErrorMessage } from "@/lib/error-inspection";
import { Avatar, Button, Select, Spinner, useToast } from "@orbmeet/ui/react";
import { enter } from "@orbmeet/ui/styles/animations";
import { focus, layout, motion } from "@orbmeet/ui/styles/atoms";
import { accent, border, ink, live, neutral, surface, warning } from "@orbmeet/ui/tokens/colors.stylex";
import { bp, env } from "@orbmeet/ui/tokens/media.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { fonts, text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";

const routeApi = getRouteApi("/_authed/library/");

const TYPES: { value: LibraryType | undefined; label: string }[] = [
  { value: undefined, label: "Everything" },
  { value: "meetings", label: "Meetings" },
  { value: "boards", label: "Boards" },
  { value: "recordings", label: "Recordings" },
];

const styles = stylex.create({
  page: {
    maxWidth: 1100,
    marginInline: "auto",
    display: "flex",
    flexDirection: "column",
    gap: space.s7,
    paddingTop: { default: space.s4, [bp.lg]: space.s7 },
  },
  title: {
    margin: 0,
    fontFamily: fonts.heading,
    fontWeight: weight.semibold,
    fontSize: { default: "2rem", [bp.sm]: "2.5rem" },
    lineHeight: 1.05,
    letterSpacing: "-0.045em",
    color: ink.strong,
  },
  lede: { margin: 0, marginTop: `calc(-1 * ${space.s2})`, fontSize: "0.9375rem", color: ink.muted },
  head: { display: "flex", flexDirection: "column", gap: space.s4 },
  search: {
    display: "flex",
    alignItems: "center",
    gap: space.s2_5,
    height: 58,
    margin: 0,
    paddingInlineStart: space.s4,
    paddingInlineEnd: space.s2,
    borderWidth: 1.5,
    borderStyle: "solid",
    borderColor: { default: border.base, ":focus-within": accent.a500 },
    borderRadius: 16,
    backgroundColor: surface.raised,
    boxShadow: { default: "none", ":focus-within": `0 0 0 4px ${accent.a200}` },
    transitionProperty: { default: "border-color, box-shadow", [env.reducedMotion]: "none" },
    transitionDuration: "160ms",
    color: ink.muted,
  },
  searchInput: {
    flexGrow: 1,
    minWidth: 0,
    height: "100%",
    borderWidth: 0,
    outlineStyle: "none",
    backgroundColor: "transparent",
    // 16px or more under a finger: iOS zooms into a smaller focused field.
    fontSize: "1.0625rem",
    color: ink.strong,
    "::placeholder": { color: neutral.n400 },
  },
  // Under the box rather than inside it, where it crowded what you type.
  hint: { margin: 0, marginTop: `calc(-1 * ${space.s2})`, fontSize: "0.78125rem", color: ink.muted },
  join: {
    display: "flex",
    alignItems: "center",
    gap: space.s3,
    paddingInline: space.s4,
    paddingBlock: space.s3,
    borderRadius: 14,
    backgroundColor: accent.a50,
    color: ink.strong,
    fontSize: text.sm,
  },
  joinCode: { fontFamily: fonts.mono },
  joinLink: {
    marginInlineStart: "auto",
    display: "inline-flex",
    alignItems: "center",
    height: 36,
    paddingInline: space.s4,
    borderRadius: 10,
    fontWeight: weight.semibold,
    color: ink.onAccent,
    textDecorationLine: "none",
    backgroundColor: accent.a600,
  },
  /**
   * What to show, then where and when. On a phone that is two rows: the kinds
   * scroll sideways in a strip that runs to the screen's edge, and the two
   * pickers share the row under it, rather than all of it wrapping into three
   * ragged lines.
   */
  filters: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: space.s2 },
  kinds: {
    display: "flex",
    flexWrap: { default: "nowrap", [bp.sm]: "wrap" },
    gap: space.s2,
    overflowX: { default: "auto", [bp.sm]: "visible" },
    marginInline: { default: `calc(-1 * ${space.s4})`, [bp.sm]: 0 },
    paddingInline: { default: space.s4, [bp.sm]: 0 },
    maxWidth: { default: `calc(100% + 2 * ${space.s4})`, [bp.sm]: "none" },
    // As wide as the bleed: at 100% it started at the screen's left edge and
    // stopped 32px short of its right, cutting "Recordings" off mid-word in
    // the middle of the page rather than at the edge.
    flexBasis: { default: `calc(100% + 2 * ${space.s4})`, [bp.sm]: "auto" },
  },
  pickers: { display: "flex", gap: space.s2, flexGrow: { default: 1, [bp.sm]: 0 } },
  chip: {
    flexShrink: 0,
    height: 34,
    paddingInline: space.s3_5,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: border.subtle,
    borderRadius: 999,
    cursor: "pointer",
    fontSize: "0.84375rem",
    color: ink.strong,
    backgroundColor: { default: surface.raised, [env.hoverable]: { default: surface.raised, ":hover": neutral.n50 } },
  },
  chipOn: { borderColor: ink.strong, color: surface.raised, backgroundColor: ink.strong },
  divider: {
    display: { default: "none", [bp.sm]: "block" },
    width: 1,
    alignSelf: "stretch",
    marginBlock: space.s1,
    marginInline: space.s1,
    backgroundColor: border.subtle,
  },
  select: {
    width: "auto",
    flexGrow: { default: 1, [bp.sm]: 0 },
    flexBasis: { default: 0, [bp.sm]: "auto" },
    minWidth: { default: 0, [bp.sm]: 140 },
    height: 34,
    borderRadius: 999,
  },

  section: { display: "flex", flexDirection: "column", gap: space.s1 },
  sectionHead: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: space.s3, paddingBottom: space.s2 },
  sectionTitle: { margin: 0, fontSize: text.base, fontWeight: weight.semibold, color: ink.strong },
  sectionNote: { fontSize: "0.8125rem", color: ink.muted },
  day: { display: "flex", flexDirection: "column", gap: space.s0_5, paddingTop: space.s3 },
  dayHead: { display: "flex", alignItems: "baseline", gap: space.s2, paddingBottom: space.s1_5 },
  dayLabel: { fontSize: "0.8125rem", fontWeight: weight.semibold, color: ink.strong },
  dayDate: { fontFamily: fonts.mono, fontSize: text.xs, color: ink.muted },
  quiet: { margin: 0, paddingBlock: space.s4, fontSize: text.sm, color: ink.muted },
  more: { paddingTop: space.s3 },

  hit: {
    display: "flex",
    alignItems: "flex-start",
    gap: space.s4,
    paddingInline: space.s3,
    paddingBlock: space.s3_5,
    marginInline: `calc(-1 * ${space.s3})`,
    borderRadius: 14,
    color: ink.strong,
    textDecorationLine: "none",
    backgroundColor: { default: "transparent", [env.hoverable]: { default: "transparent", ":hover": neutral.n50 } },
  },
  hitBody: { display: "flex", flexDirection: "column", gap: space.s1_5, flexGrow: 1, minWidth: 0 },
  hitTitle: { fontSize: text.base, fontWeight: weight.medium },
  hitMeta: { fontSize: "0.8125rem", color: ink.muted },
  quote: { fontSize: "1.0625rem", lineHeight: 1.45, letterSpacing: "-0.01em", color: ink.strong },
  offset: { fontFamily: fonts.mono, fontSize: "0.78125rem", color: accent.a700 },
  speaker: { fontWeight: weight.medium, color: ink.body },
  mark: { borderRadius: 3, paddingInline: 2, color: "inherit", backgroundColor: warning.w100 },

  board: { display: "flex", alignItems: "center", gap: space.s4 },
  boardThumb: {
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

  live: { display: "flex", flexDirection: "column", gap: space.s2 },
  liveRow: {
    display: "flex",
    alignItems: "center",
    gap: space.s3,
    paddingInline: space.s4,
    paddingBlock: space.s3,
    borderRadius: 14,
    backgroundColor: live.l50,
  },
  liveDot: { flexShrink: 0, width: 7, height: 7, borderRadius: "50%", backgroundColor: live.l500 },
  liveText: { display: "flex", flexDirection: "column", gap: 2, flexGrow: 1, minWidth: 0 },
  liveTitle: { fontSize: text.sm, fontWeight: weight.semibold, color: ink.strong },
  liveMeta: { fontSize: "0.8125rem", color: live.l800 },
  liveActions: { display: "flex", alignItems: "center", gap: space.s2 },
  liveJoin: {
    display: "inline-flex",
    alignItems: "center",
    height: 36,
    paddingInline: space.s4,
    borderRadius: 10,
    fontSize: text.sm,
    fontWeight: weight.semibold,
    color: ink.onAccent,
    textDecorationLine: "none",
    backgroundColor: live.l700,
  },
});

/** The search text, marked wherever it occurs in `value`, ignoring case. */
function Highlight({ value, query }: { value: string; query: string }) {
  const needle = query.trim().toLowerCase();
  if (!needle) return <>{value}</>;
  const parts: ReactNode[] = [];
  const haystack = value.toLowerCase();
  let at = 0;
  for (let found = haystack.indexOf(needle); found !== -1; found = haystack.indexOf(needle, at)) {
    if (found > at) parts.push(value.slice(at, found));
    parts.push(
      <mark key={found} {...stylex.props(styles.mark)}>
        {value.slice(found, found + needle.length)}
      </mark>,
    );
    at = found + needle.length;
  }
  parts.push(value.slice(at));
  return <>{parts}</>;
}

function formatOffset(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

// ─── Happening now ───────────────────────────────────────────────────────────

function EndMeetingButton({ meetingId, peopleCount, onEnded }: { meetingId: string; peopleCount: number; onEnded: () => void }) {
  const [pending, setPending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const { add: addToast } = useToast();
  const end = () => {
    setPending(true);
    endMeeting({ data: { meetingId } })
      .then(() => {
        setConfirming(false);
        onEnded();
      })
      .catch((error: unknown) => {
        addToast({
          title: "The meeting couldn’t be ended",
          description: getErrorMessage(error, "Try again in a moment."),
          data: { variant: "error" },
        });
      })
      .finally(() => setPending(false));
  };
  return (
    <>
      <Button variant="secondary" size="sm" loading={pending && !confirming} onClick={() => (peopleCount > 0 ? setConfirming(true) : end())}>
        End it
      </Button>
      <EndMeetingDialog show={confirming} pending={pending} peopleCount={peopleCount} onCancel={() => setConfirming(false)} onConfirm={end} />
    </>
  );
}

/**
 * Meetings still open. A meeting you started and left open in a closed tab
 * would otherwise sit "live" for hours with only a way in; it has a way to end.
 */
function HappeningNow() {
  const query = useInfiniteQuery(myMeetingsQueryOptions({ status: "open", limit: 100 }));
  const meetings = query.data?.pages.flatMap((page) => page.meetings) ?? [];
  if (meetings.length === 0) return null;
  return (
    <section aria-labelledby="library-live" {...stylex.props(styles.live)}>
      <h2 id="library-live" {...stylex.props(styles.sectionTitle)}>Happening now</h2>
      {meetings.map((meeting) => {
        const inRoom = meeting.liveParticipantCount;
        return (
          <div key={meeting.id} {...stylex.props(styles.liveRow)}>
            <span aria-hidden="true" {...stylex.props(styles.liveDot)} />
            <div {...stylex.props(styles.liveText)}>
              <span {...stylex.props(styles.liveTitle, layout.truncate)}>{meeting.title || meeting.spaceName || "Meeting"}</span>
              <span {...stylex.props(styles.liveMeta)}>
                {inRoom > 0 ? `${inRoom} in the room` : "Waiting for others"}
                {meeting.spaceName && meeting.title ? ` · ${meeting.spaceName}` : ""}
              </span>
            </div>
            <div {...stylex.props(styles.liveActions)}>
              {meeting.startedByMe ? (
                <EndMeetingButton meetingId={meeting.id} peopleCount={inRoom} onEnded={() => void query.refetch()} />
              ) : null}
              <a
                href={meetingEntryPath(meeting.code)}
                onClick={() => beginMeetingEntryFlow({ source: "meetings-upcoming", code: meeting.code })}
                {...stylex.props(styles.liveJoin, motion.tint, focus.ring)}
              >
                Join
              </a>
            </div>
          </div>
        );
      })}
    </section>
  );
}

// ─── What was said ───────────────────────────────────────────────────────────

function SpokenMatches({ search, viewerName }: { search: LibrarySearch; viewerName: string }) {
  const q = search.q?.trim() ?? "";
  const meetingsInput = toLibraryMeetingsInput(search);
  const query = useQuery({
    ...mySpokenLinesQueryOptions({
      search: q,
      scope: meetingsInput.scope,
      spaceId: search.spaceId,
      since: sinceFor(search.within),
    }),
    enabled: q.length >= MIN_SPOKEN_SEARCH_LENGTH,
    placeholderData: keepPreviousData,
  });
  const lines = query.data?.lines ?? [];
  if (q.length < MIN_SPOKEN_SEARCH_LENGTH || lines.length === 0) return null;
  return (
    <section aria-labelledby="library-said" {...stylex.props(styles.section, enter.fadeUp)}>
      <div {...stylex.props(styles.sectionHead)}>
        <h2 id="library-said" {...stylex.props(styles.sectionTitle)}>Said in meetings</h2>
        <span {...stylex.props(styles.sectionNote)}>From transcripts</span>
      </div>
      {lines.map((line) => (
        <Link
          key={line.id}
          to="/meetings/$meetingId"
          params={{ meetingId: line.meetingId }}
          {...stylex.props(styles.hit, motion.tint, focus.ring)}
        >
          <Avatar name={line.speaker} size="sm" />
          <span {...stylex.props(styles.hitBody)}>
            <span {...stylex.props(styles.quote)}>“<Highlight value={line.text} query={q} />”</span>
            <span {...stylex.props(styles.hitMeta)}>
              <span {...stylex.props(styles.speaker)}>{line.speaker}</span>
              {` · ${meetingDisplayTitle(line.meetingTitle, [], viewerName)} · ${formatMeetingDate(line.meetingStartedAt)} · ${line.spaceName ?? "Personal"} · `}
              <span {...stylex.props(styles.offset)}>{formatOffset(line.offsetMs)}</span>
            </span>
          </span>
        </Link>
      ))}
    </section>
  );
}

// ─── Meetings ────────────────────────────────────────────────────────────────

function MeetingResults({ search, viewerName }: { search: LibrarySearch; viewerName: string }) {
  const query = useInfiniteQuery({
    ...myMeetingsQueryOptions(toLibraryMeetingsInput(search)),
    placeholderData: keepPreviousData,
  });
  const meetings = (query.data?.pages.flatMap((page) => page.meetings) ?? []).map((meeting) => ({
    ...meeting,
    hasWhiteboard: meeting.hasWhiteboardState || meeting.hasWhiteboardPdf,
  }));
  const days = groupMeetingsByDay(meetings);
  const narrowed = Boolean(search.q || search.scope || search.spaceId || search.person || search.within || search.type);

  return (
    <section aria-labelledby="library-meetings" {...stylex.props(styles.section)}>
      <div {...stylex.props(styles.sectionHead)}>
        <h2 id="library-meetings" {...stylex.props(styles.sectionTitle)}>
          {search.type === "recordings" ? "Recordings" : "Meetings"}
        </h2>
        {query.isFetching && !query.isFetchingNextPage ? <Spinner size="sm" /> : null}
      </div>
      {query.isPending ? (
        <p {...stylex.props(styles.quiet)}>Loading…</p>
      ) : query.isError && meetings.length === 0 ? (
        <QueryErrorNotice message="Past meetings couldn’t be loaded." onRetry={() => void query.refetch()} />
      ) : days.length === 0 ? (
        <p {...stylex.props(styles.quiet)}>
          {narrowed
            ? "Nothing matches. Try other words, or fewer filters."
            : "No past meetings yet. When a meeting ends, it lands here with its board, recording and recap."}
        </p>
      ) : (
        <>
          {days.map((day) => (
            <div key={day.key} {...stylex.props(styles.day)}>
              <div {...stylex.props(styles.dayHead)}>
                <span {...stylex.props(styles.dayLabel)}>{day.label}</span>
                <span {...stylex.props(styles.dayDate)}>{day.date}</span>
              </div>
              {day.meetings.map((meeting) => (
                <MeetingRow key={meeting.meetingId} meeting={meeting} viewerName={viewerName} />
              ))}
            </div>
          ))}
          {query.hasNextPage ? (
            <div {...stylex.props(styles.more)}>
              <Button variant="secondary" size="sm" loading={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
                Show more
              </Button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

// ─── Boards ──────────────────────────────────────────────────────────────────

function BoardResults({ search, onlyMatches }: { search: LibrarySearch; onlyMatches: boolean }) {
  const query = useInfiniteQuery(myWhiteboardsQueryOptions("active"));
  const q = search.q?.trim().toLowerCase() ?? "";
  const boards = (query.data?.pages.flatMap((page) => page.whiteboards) ?? []).filter((board) => {
    if (search.scope === "personal" && board.contextKind !== "personal") return false;
    if (search.scope === "spaces" && board.contextKind !== "space") return false;
    if (search.spaceId && board.spaceId !== search.spaceId) return false;
    const since = sinceFor(search.within);
    if (since && Date.parse(board.updatedAt) < since) return false;
    if (!q) return true;
    return `${board.title} ${board.lastUsedIn ?? ""}`.toLowerCase().includes(q);
  });
  const [creating, setCreating] = useState(false);
  const { data: spacesData } = useQuery({ ...mySpacesQueryOptions(), enabled: !onlyMatches });
  if (onlyMatches && boards.length === 0) return null;

  return (
    <section aria-labelledby="library-boards" {...stylex.props(styles.section)}>
      <div {...stylex.props(styles.sectionHead)}>
        <h2 id="library-boards" {...stylex.props(styles.sectionTitle)}>Boards</h2>
        {onlyMatches ? null : (
          <Button size="sm" variant="secondary" onClick={() => setCreating(true)}>
            <Plus size={15} aria-hidden="true" /> New board
          </Button>
        )}
      </div>
      {query.isPending ? (
        <p {...stylex.props(styles.quiet)}>Loading…</p>
      ) : query.isError ? (
        <QueryErrorNotice message="Boards couldn’t be loaded." onRetry={() => void query.refetch()} />
      ) : boards.length === 0 ? (
        <p {...stylex.props(styles.quiet)}>{q ? "No boards match." : "No boards yet. A meeting’s board lands here when it ends."}</p>
      ) : (
        <>
          {boards.map((board) => (
            <Link
              key={board.id}
              to="/whiteboards/$whiteboardId"
              params={{ whiteboardId: board.id }}
              {...stylex.props(styles.hit, styles.board, motion.tint, focus.ring)}
            >
              <span aria-hidden="true" {...stylex.props(styles.boardThumb)}>
                <Presentation size={22} strokeWidth={1.5} />
              </span>
              <span {...stylex.props(styles.hitBody)}>
                <span {...stylex.props(styles.hitTitle, layout.truncate)}>
                  <Highlight value={boardDisplayTitle(board)} query={q} />
                </span>
                <span {...stylex.props(styles.hitMeta)}>
                  {board.contextName ?? "Personal"} · {board.lastUsedAt ? `Last used ${formatActivityDay(board.lastUsedAt)}` : `Edited ${formatActivityDay(board.updatedAt)}`}
                </span>
              </span>
            </Link>
          ))}
          {query.hasNextPage ? (
            <div {...stylex.props(styles.more)}>
              <Button variant="secondary" size="sm" loading={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
                Show more
              </Button>
            </div>
          ) : null}
        </>
      )}
      {onlyMatches ? null : (
        <NewWhiteboardDialog
          open={creating}
          onOpenChange={setCreating}
          spaceChoices={spacesData?.spaces.map((listed) => ({ id: listed.id, name: listed.name }))}
        />
      )}
    </section>
  );
}

/**
 * Boards put away. Out of the way, but here: an archived board doesn't count
 * against a Space's limit, and can come back.
 */
function ArchivedBoards() {
  const query = useInfiniteQuery(myWhiteboardsQueryOptions("archived"));
  const boards = query.data?.pages.flatMap((page) => page.whiteboards) ?? [];
  if (boards.length === 0) return null;
  return (
    <section aria-labelledby="library-archived" {...stylex.props(styles.section)}>
      <div {...stylex.props(styles.sectionHead)}>
        <h2 id="library-archived" {...stylex.props(styles.sectionTitle)}>Archived</h2>
        <span {...stylex.props(styles.sectionNote)}>Don’t count toward a space’s limit</span>
      </div>
      <List label="Archived boards">
        {boards.map((board) => (
          <ArchivedBoardRow key={board.id} whiteboard={board} />
        ))}
      </List>
      {query.hasNextPage ? (
        <div {...stylex.props(styles.more)}>
          <Button variant="secondary" size="sm" loading={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
            Show more
          </Button>
        </div>
      ) : null}
    </section>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export function LibraryPage() {
  const search = routeApi.useSearch();
  const navigate = routeApi.useNavigate();
  const { session: initialSession } = getRouteApi("/_authed").useRouteContext();
  const session = useAuthenticatedSession(initialSession);
  const viewerName = session.user.name ?? "";
  const inputRef = useRef<HTMLInputElement>(null);

  const routeQuery = search.q ?? "";
  const [previousRouteQuery, setPreviousRouteQuery] = useState(routeQuery);
  const [draft, setDraft] = useState(routeQuery);
  if (previousRouteQuery !== routeQuery) {
    setPreviousRouteQuery(routeQuery);
    setDraft(routeQuery);
  }

  const setFilters = useCallback(
    (patch: Partial<LibrarySearch>) => {
      void navigate({ search: (previous) => ({ ...previous, ...patch, find: undefined }), replace: true });
    },
    [navigate],
  );

  // Typing settles before the URL (and the query) follows it.
  useEffect(() => {
    const next = draft.trim() || undefined;
    if (next === search.q) return;
    const timer = window.setTimeout(() => setFilters({ q: next }), 300);
    return () => window.clearTimeout(timer);
  }, [draft, search.q, setFilters]);

  // ⌘K, or the rail's search, lands here asking for the box.
  useEffect(() => {
    if (search.find) inputRef.current?.focus();
  }, [search.find]);

  const { data: spacesData } = useQuery(mySpacesQueryOptions());
  const spaces = spacesData?.spaces ?? [];
  const where = search.spaceId ?? search.scope ?? "all";
  const code = findMeetingCode(draft);

  return (
    <div {...stylex.props(styles.page)}>
      <header {...stylex.props(styles.head, enter.fadeUp)}>
        <h1 {...stylex.props(styles.title)}>Library</h1>
        <p {...stylex.props(styles.lede)}>Everything your meetings left behind: what was said, drawn and decided.</p>
        <form role="search" onSubmit={(event) => event.preventDefault()} {...stylex.props(styles.search)}>
          <Search size={20} strokeWidth={1.9} aria-hidden="true" />
          <input
            ref={inputRef}
            type="search"
            aria-label="Search meetings, boards and what was said"
            // Short enough to read whole on a phone; the hint under it says the rest.
            placeholder="Search your meetings and boards"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            {...stylex.props(styles.searchInput)}
          />
        </form>
        <p {...stylex.props(styles.hint)}>Searches titles, recaps, transcripts and board names in the spaces you belong to.</p>
        {code ? (
          <div {...stylex.props(styles.join)}>
            <Video size={18} strokeWidth={1.75} aria-hidden="true" />
            <span>
              That looks like a meeting: <span {...stylex.props(styles.joinCode)}>{code}</span>
            </span>
            <a
              href={meetingEntryPath(code)}
              onClick={() => beginMeetingEntryFlow({ source: "home-join", code })}
              {...stylex.props(styles.joinLink, motion.tint, focus.ring)}
            >
              Join
            </a>
          </div>
        ) : null}
        <div role="group" aria-label="Filter the library" {...stylex.props(styles.filters)}>
          <div {...stylex.props(styles.kinds, layout.hideScrollbar)}>
            {TYPES.map(({ value, label }) => {
              const on = search.type === value;
              return (
                <button
                  key={label}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setFilters({ type: value })}
                  {...stylex.props(styles.chip, motion.tint, focus.ring, on && styles.chipOn)}
                >
                  {label}
                </button>
              );
            })}
            {search.person ? (
              <button
                type="button"
                onClick={() => setFilters({ person: undefined })}
                {...stylex.props(styles.chip, styles.chipOn, motion.tint, focus.ring)}
              >
                With {search.person} ×
              </button>
            ) : null}
          </div>
          <span aria-hidden="true" {...stylex.props(styles.divider)} />
          <div {...stylex.props(styles.pickers)}>
            <Select
              aria-label="Where"
              value={where}
              onValueChange={(value) =>
                setFilters(
                  !value || value === "all"
                    ? { scope: undefined, spaceId: undefined }
                    : value === "personal" || value === "spaces"
                      ? { scope: value, spaceId: undefined }
                      : { scope: "spaces", spaceId: value },
                )
              }
              sx={styles.select}
              options={[
                { label: "Any space", value: "all" },
                { label: "Personal", value: "personal" },
                ...spaces.map((listed) => ({ label: listed.name, value: listed.id })),
              ]}
            />
            <Select
              aria-label="When"
              value={search.within ?? "any"}
              onValueChange={(value) =>
                setFilters({ within: value === "week" || value === "month" || value === "year" ? value : undefined })
              }
              sx={styles.select}
              options={[
                { label: "Any time", value: "any" },
                { label: "Past week", value: "week" },
                { label: "Past month", value: "month" },
                { label: "Past year", value: "year" },
              ]}
            />
          </div>
        </div>
      </header>

      {!search.q && !search.type ? <HappeningNow /> : null}
      {search.type !== "boards" ? <SpokenMatches search={search} viewerName={viewerName} /> : null}
      {search.type !== "boards" ? <MeetingResults search={search} viewerName={viewerName} /> : null}
      {search.type === "boards" || (!search.type && search.q) ? (
        <BoardResults search={search} onlyMatches={search.type !== "boards"} />
      ) : null}
      {search.type === "boards" && !search.q ? <ArchivedBoards /> : null}
    </div>
  );
}
