import { useCallback, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { meetingAttendanceQueryOptions } from "@/app/query-client/queries/meetings";
import { formatMeetingLength, formatTimeRange } from "@/modules/meetings/client/components/meeting-format";
import { FollowUpList, type FollowUpItem } from "@/modules/transcripts/client/follow-up-list";
import { recordingSecondsAt } from "@/modules/meetings/contract/recording-file";
import type { MeetingFollowUp } from "@/modules/transcripts/server/follow-ups.server";
import * as stylex from "@stylexjs/stylex";
import { meetingTranscriptsInfiniteQueryOptions } from "@/app/query-client/queries/meeting-summary";
import { groupTranscriptTurns } from "./transcript-turns";
import { MeetingWhiteboardPanel } from "@/pages/meeting-summary/components/whiteboard-dashboard";
import {
  useEndedMeeting,
  type MeetingSummary,
  type EndedMeeting,
  type SummaryState,
} from "@/pages/meeting-summary/lib/use-ended-meeting";
import { queryKeys } from "@/app/query-client/query-keys";
import { formatDuration, formatTimeAgo } from "@/pages/meeting-summary/lib/format";
import { useNow } from "@/lib/hooks/use-now";
import { Avatar, BrandMark, Button, Card, DotList, EmptyState, Spinner } from "@orbmeet/ui/react";
import { QueryErrorNotice } from "@/app/query-client/query-error-notice";
import {
  RecordingDownloadButton,
  RecordingPlayer,
  type RecordingSeek,
} from "@/modules/meetings/client/components/recording-player";
import { BackLink } from "@/app/shell/back-link";
import { Facts, type Fact } from "@/app/shell/detail-layout";
import { List, ListGlyph, ListRow } from "@/app/shell/list";
import { Page } from "@/app/shell/page";
import { PageHeader } from "@/app/shell/page-header";
import { Section } from "@/app/shell/section";
import { focus, motion } from "@orbmeet/ui/styles/atoms";
import { accent, ink, neutral, surface, violet, warning } from "@orbmeet/ui/tokens/colors.stylex";
import { bp, env } from "@orbmeet/ui/tokens/media.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { fonts, leading, text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import {
  AlertTriangle,
  ChevronDown,
  Clock,
  MicOff,
  PenTool,
  RefreshCw,
  Sparkles,
  type LucideIcon,
} from "lucide-react";

const styles = stylex.create({
  page: {
    maxWidth: 1100,
    marginInline: "auto",
    display: "flex",
    flexDirection: "column",
    gap: space.s8,
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
  columns: { display: "flex", flexWrap: "wrap", alignItems: "flex-start", gap: space.s8 },
  main: { display: "flex", flexDirection: "column", gap: space.s8, flexGrow: 999, flexShrink: 1, flexBasis: 520, minWidth: 0 },
  aside: { display: "flex", flexDirection: "column", gap: space.s5, flexGrow: 1, flexShrink: 1, flexBasis: 320, minWidth: 0 },
  block: { display: "flex", flexDirection: "column", gap: space.s3 },
  ruled: { borderTopWidth: 1, borderTopStyle: "solid", borderTopColor: neutral.n150, paddingTop: space.s6 },
  blockHead: { display: "flex", alignItems: "center", gap: space.s2_5 },
  blockTitle: { margin: 0, fontSize: "1.0625rem", fontWeight: weight.semibold, color: ink.strong },
  byline: { fontSize: "0.8125rem", color: ink.muted },
  moments: { margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: space.s0_5 },
  moment: {
    display: "flex",
    alignItems: "baseline",
    gap: space.s4,
    width: "100%",
    paddingInline: space.s3,
    paddingBlock: space.s2_5,
    marginInline: `calc(-1 * ${space.s3})`,
    borderRadius: 12,
    textAlign: "start",
  },
  momentButton: {
    borderWidth: 0,
    cursor: "pointer",
    backgroundColor: { default: "transparent", [env.hoverable]: { default: "transparent", ":hover": neutral.n50 } },
  },
  momentAt: { flexShrink: 0, width: 52, fontFamily: fonts.mono, fontSize: "0.8125rem", color: accent.a700 },
  momentText: { display: "flex", flexDirection: "column", gap: 2, minWidth: 0 },
  momentTitle: { fontSize: text.base, fontWeight: weight.medium, color: ink.strong },
  momentDetail: { fontSize: text.sm, lineHeight: 1.45, color: ink.muted },
  spaceLink: {
    color: { default: accent.a700, [env.hoverable]: { default: accent.a700, ":hover": accent.a800 } },
    textDecorationLine: "none",
  },
  /** A record that will be deleted says so above everything else. */
  retentionLimited: {
    marginBottom: space.s8,
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
  /** One with no expiry is fine print under the facts. */
  fine: { margin: 0, fontSize: text.xs, lineHeight: leading.relaxed, color: ink.muted },

  /**
   * A short state in place of content — no speech, still writing, failed.
   * Quiet and compact: the page should not spend its first screen on
   * something that is not there.
   */
  note: {
    display: "flex",
    alignItems: "flex-start",
    gap: space.s3,
    borderRadius: radii.card,
    backgroundColor: surface.sunken,
    paddingInline: space.s4,
    paddingBlock: space.s3_5,
  },
  noteGlyph: { marginTop: space.s0_5, flexShrink: 0, color: neutral.n500 },
  noteGlyphAccent: { color: violet.v600 },
  noteBody: { minWidth: 0, flexGrow: 1 },
  noteTitle: { margin: 0, fontSize: text.sm, lineHeight: leading.sm, fontWeight: weight.medium, color: ink.strong },
  noteText: { marginTop: space.s0_5, marginBottom: 0, fontSize: text.sm, lineHeight: leading.sm, color: ink.muted },
  noteAction: { flexShrink: 0 },

  summaryCard: { padding: { default: space.s5, [bp.sm]: space.s6 } },
  summaryBody: {
    margin: 0,
    fontSize: text.base,
    lineHeight: leading.relaxed,
    color: ink.body,
    whiteSpace: "pre-line",
  },
  summaryMeta: {
    marginTop: space.s3,
    display: "flex",
    flexWrap: "wrap",
    gap: space.s3,
    fontSize: text.xs,
    color: ink.muted,
  },

  boardStatus: { color: ink.muted },

  transcriptCard: { display: "flex", flexDirection: "column", gap: space.s4 },
  transcriptLoading: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    paddingBlock: space.s8,
  },
  transcriptLine: {
    // The last line keeps no border: the card's own edge is the divider there.
    borderBottomWidth: { default: 1, ":last-child": 0 },
    borderBottomStyle: "solid",
    borderBottomColor: neutral.n100,
    paddingBottom: { default: space.s4, ":last-child": 0 },
  },
  transcriptMeta: {
    marginBottom: space.s1,
    display: "flex",
    alignItems: "center",
    gap: space.s2,
    fontSize: text.xs,
    color: ink.muted,
  },
  transcriptSpeaker: { fontWeight: weight.semibold, color: ink.strong },
  transcriptText: { margin: 0, fontSize: text.sm, lineHeight: leading.relaxed, color: ink.body },
  transcriptMore: { paddingTop: space.s2 },
});


type BackDestination = "/home" | "/library";

/**
 * The detail page for a single ended meeting. It composes four independent
 * sections — recording, whiteboard PDF, AI summary, transcript — none of which
 * gates another: the PDF is available whenever a whiteboard exists, and the
 * summary manages its own lifecycle without blocking the rest of the page.
 */
export function EndedMeetingPage({
  meetingId,
  backTo = "/library",
  backLabel = "Library",
  backSpaceSlug,
}: {
  meetingId: string;
  backTo?: BackDestination;
  backLabel?: string;
  backSpaceSlug?: string;
}) {
  const queryClient = useQueryClient();
  const [seek, setSeek] = useState<RecordingSeek | null>(null);
  const {
    meeting,
    meetingError,
    existingSummary,
    existingFollowUps,
    hasTranscript,
    summaryState,
    isRetryingSummary,
    retrySummary,
    retryMeetingLoad,
  } = useEndedMeeting({ meetingId });

  // A newly generated PDF must invalidate the archive lists so their
  // "Generate PDF" cells flip to "Download PDF".
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
  const title =
    meeting.title ||
    (endedAt ? `Meeting on ${endedAt.toLocaleDateString([], { month: "long", day: "numeric" })}` : "Meeting");
  // Each moment, with where it falls in the recording: a recording starts
  // when someone presses it, so its clock is not the meeting's.
  const moments = (existingSummary?.moments ?? []).map((moment) => ({
    ...moment,
    recordingSeconds: recording ? recordingSecondsAt(moment.atSeconds, startedAt?.toISOString() ?? null, recording.filename) : null,
  }));
  const anyPlayable = moments.some((moment) => moment.recordingSeconds !== null);
  const followUps = followUpsFor(meeting, existingFollowUps);

  // A session, read in the order people come back for it: what happened, then
  // what was shown, then every word. "Whiteboards used" earns its place only
  // when there was more than one board — with one, it is the same board as the
  // capture above it.
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
        <RecapFacts meetingId={meetingId} startedAt={startedAt?.toISOString() ?? null} endedAt={endedAt?.toISOString() ?? null} />
      </header>

      {meeting.retainUntil ? <RetentionNotice retainUntil={meeting.retainUntil} /> : null}

      <div {...stylex.props(styles.columns)}>
        <article {...stylex.props(styles.main)}>
          <section aria-labelledby="recap-summary" {...stylex.props(styles.block)}>
            <div {...stylex.props(styles.blockHead)}>
              {/* Orb's mark turns while the summary is being written, and is still once it is. */}
              <BrandMark size={20} state={!existingSummary && summaryState?.status === "pending" ? "thinking" : "rest"} />
              <h2 id="recap-summary" {...stylex.props(styles.blockTitle)}>Summary</h2>
              <span {...stylex.props(styles.byline)}>by Orb</span>
            </div>
            <SummarySection
              hasTranscript={hasTranscript}
              summary={existingSummary}
              state={summaryState}
              isRetrying={isRetryingSummary}
              onRetry={retrySummary}
            />
          </section>

          {moments.length > 0 ? (
            <section aria-labelledby="recap-moments" {...stylex.props(styles.block)}>
              <h2 id="recap-moments" {...stylex.props(styles.blockTitle)}>Key moments</h2>
              <ol {...stylex.props(styles.moments)}>
                {moments.map((moment) => {
                  const body = (
                    <>
                      <span {...stylex.props(styles.momentAt)}>{formatOffset(moment.atSeconds)}</span>
                      <span {...stylex.props(styles.momentText)}>
                        <span {...stylex.props(styles.momentTitle)}>{moment.title}</span>
                        {moment.detail ? <span {...stylex.props(styles.momentDetail)}>{moment.detail}</span> : null}
                      </span>
                    </>
                  );
                  const recordingSeconds = moment.recordingSeconds;
                  return (
                    <li key={`${moment.atSeconds}-${moment.title}`}>
                      {recordingSeconds !== null ? (
                        <button
                          type="button"
                          onClick={() => {
                            setSeek({ seconds: recordingSeconds, key: Date.now() });
                            document.getElementById("recording")?.scrollIntoView({ behavior: "smooth", block: "center" });
                          }}
                          {...stylex.props(styles.moment, styles.momentButton, motion.tint, focus.ring)}
                        >
                          {body}
                        </button>
                      ) : (
                        <div {...stylex.props(styles.moment)}>{body}</div>
                      )}
                    </li>
                  );
                })}
              </ol>
            </section>
          ) : null}

          {followUps.length > 0 ? (
            <section aria-labelledby="recap-follow-ups" {...stylex.props(styles.block, styles.ruled)}>
              <h2 id="recap-follow-ups" {...stylex.props(styles.blockTitle)}>Follow-ups</h2>
              <FollowUpList meetingId={meetingId} items={followUps} />
            </section>
          ) : null}

          {meeting.whiteboardCaptureState !== "none" ? (
            <Section id="whiteboard" title="Board">
              <MeetingWhiteboardPanel meeting={meeting} onGenerated={refreshMeetingLists} />
            </Section>
          ) : null}

          {showBoardsList ? (
            <Section id="whiteboards-shown" title="Boards used">
              <WhiteboardsShownList whiteboards={meeting.whiteboardsShown} />
            </Section>
          ) : null}

          {hasTranscript ? (
            <Section id="transcript" title="Transcript">
              <TranscriptSection meetingId={meetingId} />
            </Section>
          ) : null}
        </article>

        <aside aria-label="About this meeting" {...stylex.props(styles.aside)}>
          {recording ? (
            <Section
              id="recording"
              title="Recording"
              action={<RecordingDownloadButton artifactId={recording.id} filename={recording.filename} />}
            >
              <RecordingPlayer artifactId={recording.id} filename={recording.filename} seek={seek} />
              {anyPlayable ? (
                <p {...stylex.props(styles.fine)}>Pick a key moment to play from where it began.</p>
              ) : null}
            </Section>
          ) : null}
          <Facts items={meetingFacts(startedAt, endedAt, existingSummary)} />
          {meeting.retainUntil ? null : (
            <p {...stylex.props(styles.fine)}>
              Kept without an expiry date. Editable boards and space files follow their space.
            </p>
          )}
        </aside>
      </div>
    </div>
  );
}

/** "22:05", or "1:04:30" past the hour: how far into the meeting. */
function formatOffset(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function followUpsFor(_meeting: EndedMeeting, followUps: readonly MeetingFollowUp[]): FollowUpItem[] {
  return followUps.map((followUp) => ({
    id: followUp.id,
    text: followUp.text,
    done: followUp.done,
    detail: followUp.ownerName ?? undefined,
  }));
}

/** When it ran, for how long, and who was there. */
function RecapFacts({ meetingId, startedAt, endedAt }: { meetingId: string; startedAt: string | null; endedAt: string | null }) {
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

function meetingFacts(
  startedAt: Date | null,
  endedAt: Date | null,
  summary: MeetingSummary | null,
): Fact[] {
  const day = startedAt ?? endedAt;
  const time = (date: Date) => date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const facts: Fact[] = [];
  if (day) {
    facts.push({
      label: "Date",
      value: day.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", year: "numeric" }),
    });
  }
  if (startedAt && endedAt) {
    facts.push({ label: "Time", value: `${time(startedAt)} – ${time(endedAt)}` });
  }
  const seconds =
    summary?.durationSeconds ??
    (startedAt && endedAt ? Math.round((endedAt.getTime() - startedAt.getTime()) / 1000) : null);
  if (seconds != null && seconds > 0) facts.push({ label: "Duration", value: formatDuration(seconds) });
  if (summary?.participantCount != null) {
    facts.push({ label: "Participants", value: String(summary.participantCount) });
  }
  return facts;
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

/** A compact stand-in for content that is missing, pending, or failed. */
function Note({
  icon: Icon,
  accentIcon,
  title,
  children,
  action,
}: {
  icon: LucideIcon;
  accentIcon?: boolean;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div {...stylex.props(styles.note)}>
      <Icon size={18} {...stylex.props(styles.noteGlyph, accentIcon && styles.noteGlyphAccent)} />
      <div {...stylex.props(styles.noteBody)}>
        <p {...stylex.props(styles.noteTitle)}>{title}</p>
        {children ? <p {...stylex.props(styles.noteText)}>{children}</p> : null}
      </div>
      {action ? <div {...stylex.props(styles.noteAction)}>{action}</div> : null}
    </div>
  );
}

/**
 * "Whiteboards used" — the captured versions used in this Meeting.
 *
 * A Meeting may use several Whiteboards, and each gets its own capture
 * when the Meeting ends. The board keeps changing afterwards; this section is
 * the record of what was on it at the time, which is why the title shown is the
 * one the board carried at the end rather than whatever it is called now.
 */
function WhiteboardsShownList({
  whiteboards,
}: {
  whiteboards: EndedMeeting["whiteboardsShown"];
}) {
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

function SummarySection({
  hasTranscript,
  summary,
  state,
  isRetrying,
  onRetry,
}: {
  hasTranscript: boolean;
  summary: MeetingSummary | null;
  state: SummaryState | null;
  isRetrying: boolean;
  onRetry: () => void;
}) {
  if (summary) return <SummaryContent summary={summary} />;

  if (!hasTranscript) {
    return (
      <Note icon={MicOff} title="No summary for this meeting">
        Nobody spoke while captions were on, so there was nothing to summarize.
      </Note>
    );
  }

  switch (state?.status) {
    case "pending":
      return (
        <Note icon={Sparkles} accentIcon title="Writing the summary…">
          This usually takes a few seconds.
        </Note>
      );
    case "failed":
      return (
        <Note
          icon={AlertTriangle}
          title="Could not generate summary"
          action={
            <Button variant="secondary" size="sm" onClick={onRetry} disabled={isRetrying}>
              <RefreshCw size={14} />
              Try again
            </Button>
          }
        >
          Something went wrong while reading the transcript.
        </Note>
      );
    case "skipped":
      return <SkippedSummaryNote reason={state.reason} />;
    default:
      return null;
  }
}

function SkippedSummaryNote({ reason }: { reason: Extract<SummaryState, { status: "skipped" }>["reason"] }) {
  switch (reason) {
    case "ai_not_configured":
      return (
        <Note icon={AlertTriangle} title="AI summary unavailable">
          AI features are not configured for this workspace. Contact your administrator.
        </Note>
      );
    case "transcript_too_large":
      return (
        <Note icon={AlertTriangle} title="Transcript too large">
          This transcript is too large to summarize in one pass. Read the transcript below instead.
        </Note>
      );
    case "no_transcript":
      return (
        <Note icon={MicOff} title="No summary for this meeting">
          Too little was said to summarize. Read the transcript below instead.
        </Note>
      );
  }
}

function SummaryContent({ summary }: { summary: MeetingSummary }) {
  const now = useNow(30_000, summary.createdAt !== null);
  const partial =
    summary.transcribedParticipantCount != null &&
    summary.participantCount != null &&
    summary.transcribedParticipantCount < summary.participantCount;
  return (
    <Card sx={styles.summaryCard}>
      <p {...stylex.props(styles.summaryBody)}>{summary.summary}</p>
      {partial || summary.createdAt ? (
        <div {...stylex.props(styles.summaryMeta)}>
          {partial ? (
            <span>
              Transcript covers {summary.transcribedParticipantCount} of {summary.participantCount} participants
            </span>
          ) : null}
          {summary.createdAt ? <span>Generated {formatTimeAgo(summary.createdAt, now)}</span> : null}
        </div>
      ) : null}
    </Card>
  );
}

function TranscriptSection({ meetingId }: { meetingId: string }) {
  const [expanded, setExpanded] = useState(false);

  if (!expanded) {
    return (
      <Button variant="secondary" size="sm" onClick={() => setExpanded(true)} aria-expanded={false}>
        <ChevronDown size={14} />
        Show full transcript
      </Button>
    );
  }
  return <TranscriptList meetingId={meetingId} />;
}

function TranscriptList({ meetingId }: { meetingId: string }) {
  const { data, isPending, isError, refetch, hasNextPage, fetchNextPage, isFetchingNextPage } =
    useInfiniteQuery(meetingTranscriptsInfiniteQueryOptions(meetingId));
  const transcripts = data?.pages.flatMap((page) => page.transcripts) ?? [];

  if (isPending) {
    return (
      <Card sx={styles.transcriptLoading}>
        <Spinner size="md" brand />
      </Card>
    );
  }

  if (isError) {
    return (
      <QueryErrorNotice
        message="Transcript could not be loaded."
        onRetry={() => { void refetch(); }}
      />
    );
  }

  if (transcripts.length === 0) {
    return <Note icon={MicOff} title="Transcript unavailable" />;
  }

  return (
    <Card sx={styles.transcriptCard}>
      {groupTranscriptTurns(transcripts).map((turn) => (
        <div key={turn.key} {...stylex.props(styles.transcriptLine)}>
          <div {...stylex.props(styles.transcriptMeta)}>
            <span {...stylex.props(styles.transcriptSpeaker)}>{turn.participantName}</span>
            <span>
              {turn.startedAt.toLocaleTimeString([], {
                hour: "numeric",
                minute: "2-digit",
              })}
            </span>
          </div>
          <p {...stylex.props(styles.transcriptText)}>{turn.text}</p>
        </div>
      ))}
      {hasNextPage && (
        <div {...stylex.props(styles.transcriptMore)}>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void fetchNextPage()}
            disabled={isFetchingNextPage}
          >
            {isFetchingNextPage ? "Loading..." : "Load more"}
          </Button>
        </div>
      )}
    </Card>
  );
}
