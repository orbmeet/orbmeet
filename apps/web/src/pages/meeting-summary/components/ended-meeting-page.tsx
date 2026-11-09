import { useCallback, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { sessionQueryOptions } from "@/app/query-client/queries/session";
import { meetingAttendanceQueryOptions } from "@/app/query-client/queries/meetings";
import { formatMeetingLength, formatTimeRange, meetingDisplayTitle } from "@/modules/meetings/client/components/meeting-format";
import * as stylex from "@stylexjs/stylex";
import { meetingTranscriptsInfiniteQueryOptions } from "@/app/query-client/queries/meeting-summary";
import { groupTranscriptTurns } from "./transcript-turns";
import { MeetingWhiteboardPanel } from "@/pages/meeting-summary/components/whiteboard-dashboard";
import { useEndedMeeting, type EndedMeeting } from "@/pages/meeting-summary/lib/use-ended-meeting";
import { queryKeys } from "@/app/query-client/query-keys";
import { Avatar, Button, Card, DotList, EmptyState, Spinner } from "@orbmeet/ui/react";
import { QueryErrorNotice } from "@/app/query-client/query-error-notice";
import { RecordingDownloadButton, RecordingPlayer } from "@/modules/meetings/client/components/recording-player";
import { BackLink } from "@/app/shell/back-link";
import { List, ListGlyph, ListRow } from "@/app/shell/list";
import { Page } from "@/app/shell/page";
import { PageHeader } from "@/app/shell/page-header";
import { Section } from "@/app/shell/section";
import { focus, motion } from "@orbmeet/ui/styles/atoms";
import { accent, ink, neutral, surface, warning } from "@orbmeet/ui/tokens/colors.stylex";
import { bp, env } from "@orbmeet/ui/tokens/media.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { fonts, leading, text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import { AlertTriangle, Clock, Download, MicOff, PenTool, RefreshCw } from "lucide-react";

export type MeetingView = "pdf" | "recording" | "transcript";

const VIEW_LABELS: Record<MeetingView, string> = { pdf: "PDF", recording: "Recording", transcript: "Transcript" };

const styles = stylex.create({
  page: {
    maxWidth: 1100,
    marginInline: "auto",
    display: "flex",
    flexDirection: "column",
    gap: space.s6,
    paddingTop: { default: space.s4, [bp.lg]: space.s7 },
  },
  header: { display: "flex", flexDirection: "column", gap: space.s3 },
  crumbs: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: space.s2, fontSize: "0.84375rem", color: ink.muted },
  title: {
    margin: 0,
    fontFamily: fonts.heading,
    fontWeight: weight.semibold,
    fontSize: { default: "2rem", [bp.sm]: "2.5rem" },
    lineHeight: 1.05,
    letterSpacing: "-0.045em",
    color: ink.strong,
    overflowWrap: "anywhere",
  },
  facts: { fontSize: text.sm, color: ink.muted },
  mono: { fontFamily: fonts.mono, fontSize: "0.8125rem" },
  people: { display: "inline-flex", alignItems: "center", gap: space.s2, color: ink.body },
  faces: { display: "flex", paddingInlineStart: 3 },
  // A light overlap: at -6 the next face's ring hid the end of two-letter initials ("AR" read "AF").
  face: { marginInlineStart: -3, fontWeight: weight.semibold, boxShadow: `0 0 0 2px ${surface.raised}` },
  spaceLink: {
    color: { default: accent.a700, [env.hoverable]: { default: accent.a700, ":hover": accent.a800 } },
    textDecorationLine: "none",
  },
  /** A record that will be deleted says so above everything else. */
  retentionLimited: {
    display: "flex",
    alignItems: "flex-start",
    gap: space.s2,
    borderRadius: radii.card,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: warning.w200,
    backgroundColor: warning.w50,
    paddingInline: space.s4,
    paddingBlock: space.s3,
    fontSize: text.sm,
    lineHeight: leading.sm,
    color: warning.w800,
  },
  retentionGlyph: { marginTop: space.s0_5, flexShrink: 0 },

  tabBar: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: space.s2 },
  tabs: { display: "flex", gap: space.s1 },
  tab: {
    height: 40,
    paddingInline: space.s4,
    borderWidth: 0,
    borderRadius: 10,
    cursor: "pointer",
    fontFamily: "inherit",
    fontSize: text.sm,
    fontWeight: weight.semibold,
    color: ink.body,
    backgroundColor: { default: "transparent", [env.hoverable]: { default: "transparent", ":hover": neutral.n100 } },
  },
  tabOn: { color: accent.a700, backgroundColor: accent.a100 },
  tabAction: { marginInlineStart: "auto" },
  panel: { display: "flex", flexDirection: "column", gap: space.s4, minWidth: 0 },
  panelHidden: { display: "none" },

  transcriptCard: { display: "flex", flexDirection: "column", gap: space.s4 },
  transcriptLoading: { display: "flex", alignItems: "center", justifyContent: "center", paddingBlock: space.s8 },
  transcriptLine: {
    // The last line keeps no border: the card's own edge is the divider there.
    borderBottomWidth: { default: 1, ":last-child": 0 },
    borderBottomStyle: "solid",
    borderBottomColor: neutral.n100,
    paddingBottom: { default: space.s4, ":last-child": 0 },
  },
  transcriptMeta: { marginBottom: space.s1, display: "flex", alignItems: "center", gap: space.s2, fontSize: text.xs, color: ink.muted },
  transcriptSpeaker: { fontWeight: weight.semibold, color: ink.strong },
  transcriptText: { margin: 0, fontSize: text.sm, lineHeight: leading.relaxed, color: ink.body },
  boardStatus: { color: ink.muted },
});

type BackDestination = "/home" | "/library";

/**
 * A single ended meeting: the title, then what it left behind — the PDF, the
 * recording if one was made, and the transcript — one at a time. A tab only
 * exists when there is something behind it.
 */
export function EndedMeetingPage({
  meetingId,
  backTo = "/library",
  backLabel = "Library",
  backSpaceSlug,
  view,
}: {
  meetingId: string;
  backTo?: BackDestination;
  backLabel?: string;
  backSpaceSlug?: string;
  view?: MeetingView;
}) {
  const queryClient = useQueryClient();
  const viewerName = useQuery(sessionQueryOptions()).data?.user.name ?? undefined;
  const { meeting, meetingError, hasTranscript, retryMeetingLoad } = useEndedMeeting({ meetingId });
  const [picked, setPicked] = useState<MeetingView | undefined>(view);

  // A newly generated PDF must invalidate the archive lists so their
  // PDF buttons download straight away.
  const refreshMeetingLists = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.meetings.lists() });
  }, [queryClient]);

  const backLink = backSpaceSlug ? (
    <BackLink link={{ to: "/space/$spaceSlug", params: { spaceSlug: backSpaceSlug }, search: { tab: "meetings" } }}>
      {meeting?.spaceName ?? "Space"}
    </BackLink>
  ) : (
    <BackLink link={{ to: backTo }}>{backLabel}</BackLink>
  );

  if (meetingError) {
    return (
      <Page width="default">
        <PageHeader back={backLink} title="Meeting" />
        <EmptyState
          icon={AlertTriangle}
          title="Couldn't load this meeting"
          description="Something went wrong loading this meeting. Please try again."
          action={
            <Button variant="secondary" size="sm" onClick={() => void retryMeetingLoad()}>
              <RefreshCw size={14} />
              Retry
            </Button>
          }
        />
      </Page>
    );
  }

  if (!meeting) {
    return (
      <Page width="default">
        <PageHeader back={backLink} title="Meeting" />
        <EmptyState
          icon={Clock}
          title="Meeting unavailable"
          description="This Meeting does not exist, has not ended, or you no longer have access to it."
        />
      </Page>
    );
  }

  const recording = meeting.recording ?? null;
  const startedAt = meeting.startedAt ? new Date(meeting.startedAt) : null;
  const endedAt = meeting.endedAt ? new Date(meeting.endedAt) : null;
  const title = meetingDisplayTitle(meeting.title, meeting.participantNames, viewerName);
  const hasPdf = meeting.whiteboardCaptureState !== "none";
  const views = [hasPdf && "pdf", recording && "recording", hasTranscript && "transcript"].filter(
    (item): item is MeetingView => Boolean(item),
  );
  const active = picked && views.includes(picked) ? picked : views[0];
  // "Boards used" earns its place only when there was more than one board, or
  // when the one board has no saved copy to show above it.
  const showBoardsList =
    meeting.whiteboardsShown.length > 1 ||
    (meeting.whiteboardsShown.length === 1 && meeting.whiteboardCaptureState === "none");

  return (
    <div {...stylex.props(styles.page)}>
      <header {...stylex.props(styles.header)}>
        <nav aria-label="Breadcrumb" {...stylex.props(styles.crumbs)}>
          {meeting.spaceKind === "shared" && meeting.spaceName && meeting.spaceSlug ? (
            <Link
              to="/space/$spaceSlug"
              params={{ spaceSlug: meeting.spaceSlug }}
              search={{ tab: "meetings" }}
              {...stylex.props(styles.spaceLink, motion.tint)}
            >
              {meeting.spaceName}
            </Link>
          ) : backSpaceSlug ? (
            backLink
          ) : (
            <Link to={backTo} {...stylex.props(styles.spaceLink, motion.tint)}>
              {backLabel}
            </Link>
          )}
          {startedAt ? (
            <>
              <span aria-hidden="true">/</span>
              <span>{startedAt.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" })}</span>
            </>
          ) : null}
        </nav>
        <h1 {...stylex.props(styles.title)}>{title}</h1>
        <MeetingFacts meetingId={meetingId} startedAt={startedAt?.toISOString() ?? null} endedAt={endedAt?.toISOString() ?? null} />
      </header>

      {meeting.retainUntil ? <RetentionNotice retainUntil={meeting.retainUntil} /> : null}

      {views.length === 0 ? (
        <EmptyState icon={MicOff} title="Nothing was saved from this meeting" description="There’s no board, recording or transcript to show." />
      ) : (
        <>
          <div {...stylex.props(styles.tabBar)}>
            <div role="tablist" aria-label="What this meeting left" {...stylex.props(styles.tabs)}>
              {views.map((item) => (
                <button
                  key={item}
                  type="button"
                  role="tab"
                  id={`meeting-tab-${item}`}
                  aria-selected={item === active}
                  aria-controls={`meeting-panel-${item}`}
                  onClick={() => setPicked(item)}
                  {...stylex.props(styles.tab, motion.tint, focus.ring, item === active && styles.tabOn)}
                >
                  {VIEW_LABELS[item]}
                </button>
              ))}
            </div>
            {active === "recording" && recording ? (
              <span {...stylex.props(styles.tabAction)}>
                <RecordingDownloadButton artifactId={recording.id} filename={recording.filename} />
              </span>
            ) : null}
          </div>

          {/* The board stays mounted: leaving the tab must not throw away a PDF being made. */}
          {hasPdf ? (
            <div role="tabpanel" id="meeting-panel-pdf" aria-labelledby="meeting-tab-pdf" hidden={active !== "pdf"} {...stylex.props(styles.panel, active !== "pdf" && styles.panelHidden)}>
              <MeetingWhiteboardPanel meeting={meeting} onGenerated={refreshMeetingLists} />
            </div>
          ) : null}
          {active === "recording" && recording ? (
            <div role="tabpanel" id="meeting-panel-recording" aria-labelledby="meeting-tab-recording" {...stylex.props(styles.panel)}>
              <RecordingPlayer artifactId={recording.id} filename={recording.filename} seek={null} />
            </div>
          ) : null}
          {active === "transcript" ? (
            <div role="tabpanel" id="meeting-panel-transcript" aria-labelledby="meeting-tab-transcript" {...stylex.props(styles.panel)}>
              <TranscriptList meetingId={meetingId} filename={title} />
            </div>
          ) : null}
        </>
      )}

      {showBoardsList ? (
        <Section id="whiteboards-shown" title="Boards used">
          <WhiteboardsShownList whiteboards={meeting.whiteboardsShown} />
        </Section>
      ) : null}
    </div>
  );
}

/** When it ran, for how long, and who was there. */
function MeetingFacts({ meetingId, startedAt, endedAt }: { meetingId: string; startedAt: string | null; endedAt: string | null }) {
  const attendance = useInfiniteQuery(meetingAttendanceQueryOptions(meetingId));
  const names = [
    ...new Set((attendance.data?.pages[0]?.participants ?? []).map((participant) => participant.displayName)),
  ];
  const length = formatMeetingLength(startedAt, endedAt);
  return (
    <DotList sx={styles.facts}>
      {startedAt ? <span {...stylex.props(styles.mono)}>{formatTimeRange(startedAt, endedAt)}</span> : null}
      {length ? <span>{length}</span> : null}
      {names.length > 0 ? (
        <span {...stylex.props(styles.people)}>
          <span aria-hidden="true" {...stylex.props(styles.faces)}>
            {names.slice(0, 4).map((name) => (
              <Avatar key={name} name={name} sizePx={24} sx={styles.face} />
            ))}
          </span>
          {names.join(", ")}
        </span>
      ) : null}
    </DotList>
  );
}

function RetentionNotice({ retainUntil }: { retainUntil: string | Date }) {
  const date = new Date(retainUntil).toLocaleDateString([], { year: "numeric", month: "long", day: "numeric" });
  return (
    <div role="note" {...stylex.props(styles.retentionLimited)}>
      <Clock size={14} {...stylex.props(styles.retentionGlyph)} />
      <span>
        This Meeting&apos;s recordings, Transcript, Summary, Whiteboard captures, and handout are
        available until {date}. Editable Whiteboards, their Space history, and reusable Files continue
        separately.
      </span>
    </div>
  );
}

/**
 * The boards a meeting used. Each gets its own capture when the meeting ends,
 * and the board keeps changing afterwards, so the title shown is the one it
 * carried at the end rather than whatever it is called now.
 */
function WhiteboardsShownList({ whiteboards }: { whiteboards: EndedMeeting["whiteboardsShown"] }) {
  return (
    <List label="Whiteboards used">
      {whiteboards.map((board) => (
        <ListRow
          key={board.whiteboardId}
          leading={<ListGlyph><PenTool size={16} /></ListGlyph>}
          title={board.title}
          link={
            board.openable
              ? { to: "/whiteboards/$whiteboardId", params: { whiteboardId: board.whiteboardId } }
              : undefined
          }
          meta={
            <span {...stylex.props(styles.boardStatus)}>
              {board.snapshotId
                ? "Captured as participants saw it"
                : board.captureStatus === "failed"
                  ? "This Whiteboard could not be saved"
                  : "Capturing…"}
            </span>
          }
        />
      ))}
    </List>
  );
}

type TranscriptPage = { transcripts: Parameters<typeof groupTranscriptTurns>[0] };

/** A meeting's words as a plain text file: "[3:04 PM] Maya: So it's a quadratic?". */
function downloadTranscript(pages: readonly TranscriptPage[], filename: string) {
  const text = groupTranscriptTurns(pages.flatMap((page) => page.transcripts))
    .map((turn) => {
      const time = turn.startedAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      return `[${time}] ${turn.participantName}: ${turn.text}`;
    })
    .join("\n\n");
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${filename} transcript.txt`;
  link.click();
  URL.revokeObjectURL(url);
}

function TranscriptList({ meetingId, filename }: { meetingId: string; filename: string }) {
  const { data, isPending, isError, refetch, hasNextPage, fetchNextPage, isFetchingNextPage } =
    useInfiniteQuery(meetingTranscriptsInfiniteQueryOptions(meetingId));
  const [downloading, setDownloading] = useState(false);
  const transcripts = data?.pages.flatMap((page) => page.transcripts) ?? [];

  if (isPending) {
    return (
      <Card sx={styles.transcriptLoading}>
        <Spinner size="md" brand />
      </Card>
    );
  }

  if (isError) {
    return <QueryErrorNotice message="Transcript could not be loaded." onRetry={() => { void refetch(); }} />;
  }

  if (transcripts.length === 0) {
    return <EmptyState icon={MicOff} title="Transcript unavailable" />;
  }

  // The whole transcript, however little of it has been scrolled to yet.
  const download = async () => {
    setDownloading(true);
    try {
      let pages = data?.pages ?? [];
      let more = hasNextPage;
      while (more) {
        const result = await fetchNextPage();
        pages = result.data?.pages ?? pages;
        more = result.hasNextPage && !result.isError;
      }
      downloadTranscript(pages, filename);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <>
      <div>
        <Button variant="secondary" size="sm" loading={downloading} onClick={() => void download()}>
          <Download size={14} aria-hidden="true" />
          Download transcript
        </Button>
      </div>
      <Card sx={styles.transcriptCard}>
        {groupTranscriptTurns(transcripts).map((turn) => (
          <div key={turn.key} {...stylex.props(styles.transcriptLine)}>
            <div {...stylex.props(styles.transcriptMeta)}>
              <span {...stylex.props(styles.transcriptSpeaker)}>{turn.participantName}</span>
              <span>{turn.startedAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
            </div>
            <p {...stylex.props(styles.transcriptText)}>{turn.text}</p>
          </div>
        ))}
        {hasNextPage ? (
          <div>
            <Button variant="secondary" size="sm" onClick={() => void fetchNextPage()} disabled={isFetchingNextPage}>
              {isFetchingNextPage ? "Loading..." : "Load more"}
            </Button>
          </div>
        ) : null}
      </Card>
    </>
  );
}
