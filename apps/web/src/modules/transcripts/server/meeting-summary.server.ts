/**
 * Server implementations behind the RPC declarations in this directory.
 * Split from the sibling RPC file so the declaration file carries no
 * DB/Drizzle imports and stays safe to include in client route graphs.
 */

import type { Database } from "@orbmeet/db";
import { meetingArtifacts, meetingWhiteboards, meetings, meetingSummaries, spaces, whiteboards } from "@orbmeet/db/schema";
import { and, desc, eq } from "drizzle-orm";
import { canAccessMeetingHistory } from "@/modules/meetings/server/access/resource-access";
import { canManagePastMeeting } from "@/modules/meetings/server/access/access-assertions";
import { deriveWhiteboardCaptureState } from "@/modules/whiteboards/server/meeting/capture";
import { listTranscriptRowsPage } from "./query";
import { summaryMatchesTranscriptSnapshot, type TranscriptSnapshot } from "@/modules/transcripts/server/generate-summary.server";
import { DEFAULT_TRANSCRIPT_PAGE_SIZE } from "../contract/page";
import { isSummaryGenerationConfigured } from "@/modules/meetings/server/history/summary-generation-policy";
import type { AuthFnContext } from "@/app/bootstrap/middleware";
import { summaryStateOf } from "./summary-state";
import { selectMeetingFollowUps } from "./follow-ups.server";
import type { MeetingLocatorInput } from "./meeting-summary.functions";
import type { MeetingTranscriptsInput } from "./meeting-summary.functions";

interface PresentedWhiteboardRow {
  whiteboardId: string;
  captureStatus: "live" | "capturing" | "captured" | "failed";
  capturedRevisionId: string | null;
  titleAtEnd: string | null;
  title: string;
  status: "active" | "archived";
}

/**
 * The Whiteboards a Meeting presented, for the "Whiteboards shown" section.
 *
 * One of exactly two places a Snapshot is surfaced — the other is the board's
 * own History panel. Never a picker: nobody should be choosing between frozen
 * copies while a class waits.
 */
export function toWhiteboardsShown(rows: readonly PresentedWhiteboardRow[]) {
  return rows.map((row) => ({
    whiteboardId: row.whiteboardId,
    // The name the board carried when the Meeting ended, so renaming it on
    // Tuesday does not rewrite what this page says Monday's class saw. The live
    // title only stands in for a capture written before titles were mandatory.
    title: row.titleAtEnd ?? row.title,
    snapshotId: row.capturedRevisionId,
    captureStatus: row.captureStatus,
    // An archived board still happened; it just cannot be opened live.
    openable: row.status === "active",
  }));
}

/**
 * The access-gated Meeting shared by the Summary and Transcript endpoints.
 * Returns null when the Meeting does not exist / has not ended, or the caller
 * cannot see its history — callers surface either as an empty result. The
 * Transcript counters are read from this same row so neither the ended-Meeting
 * builder nor the freshness check re-reads the Meeting.
 */
async function resolveAccessibleMeeting(db: Database, userId: string, meetingId: string) {
  const [row] = await db
    .select({
      meetingId: meetings.id,
      title: meetings.title,
      startedAt: meetings.startedAt,
      endedAt: meetings.endedAt,
      retainUntil: meetings.retainUntil,
      billingPlan: meetings.billingPlan,
      startedByUserId: meetings.startedByUserId,
      spaceId: meetings.spaceId,
      spaceKind: meetings.spaceKind,
      spaceName: spaces.name,
      spaceSlug: spaces.slug,
      transcriptSegmentCount: meetings.transcriptSegmentCount,
      transcriptLastIngestedAt: meetings.transcriptLastIngestedAt,
      summaryStatus: meetings.summaryStatus,
      summarySkipReason: meetings.summarySkipReason,
    })
    .from(meetings)
    .leftJoin(spaces, eq(spaces.id, meetings.spaceId))
    .where(and(eq(meetings.status, "ended"), eq(meetings.id, meetingId)))
    .limit(1);

  if (!row) return null;
  if (!(await canAccessMeetingHistory(db, row.meetingId, userId))) return null;

  const { transcriptSegmentCount, transcriptLastIngestedAt, summaryStatus, summarySkipReason, ...meeting } = row;
  return {
    meeting,
    summary: { summaryStatus, summarySkipReason },
    transcriptSnapshot: {
      segmentCount: transcriptSegmentCount,
      lastUpdatedAt: transcriptLastIngestedAt,
    } satisfies TranscriptSnapshot,
  };
}

type ResolvedMeeting = NonNullable<Awaited<ReturnType<typeof resolveAccessibleMeeting>>>;

/**
 * Enriches an access-gated Meeting into the ended-Meeting payload. Every lookup
 * here depends only on the Meeting, so they run concurrently.
 */
async function buildEndedMeeting(db: Database, resolved: ResolvedMeeting, userId: string) {
  const { meeting } = resolved;

  const [artifactRows, documentStates, canManageMeeting] = await Promise.all([
    db
      .select({
        type: meetingArtifacts.type,
        id: meetingArtifacts.id,
        r2Key: meetingArtifacts.r2Key,
        filename: meetingArtifacts.filename,
        size: meetingArtifacts.size,
      })
      .from(meetingArtifacts)
      .where(eq(meetingArtifacts.meetingId, meeting.meetingId)),
    // Every Whiteboard this Meeting presented, not merely whether it presented
    // one: a Meeting may present several, and each gets its own Snapshot when
    // the Meeting ends. `titleAtEnd` is what the board was called at the time,
    // so a later rename does not rewrite what this page says the class saw.
    db
      .select({
        whiteboardId: meetingWhiteboards.whiteboardId,
        captureStatus: meetingWhiteboards.captureStatus,
        capturedRevisionId: meetingWhiteboards.capturedRevisionId,
        titleAtEnd: meetingWhiteboards.titleAtEnd,
        title: whiteboards.title,
        status: whiteboards.status,
        lastPresentedAt: meetingWhiteboards.lastPresentedAt,
        attachedAt: meetingWhiteboards.attachedAt,
        lastSharedSnapshotR2Key: meetingWhiteboards.lastSharedSnapshotR2Key,
      })
      .from(meetingWhiteboards)
      .innerJoin(whiteboards, eq(whiteboards.id, meetingWhiteboards.whiteboardId))
      .where(eq(meetingWhiteboards.meetingId, meeting.meetingId))
      .orderBy(meetingWhiteboards.attachedAt),
    canManagePastMeeting(db, meeting, userId),
  ]);

  const artifactTypes = new Set(artifactRows.map((artifact) => artifact.type));
  const recording = artifactRows.find((a) => a.type === "recording") ?? null;
  const hasWhiteboardState =
    documentStates.some(
      (state) => state.captureStatus === "captured" || Boolean(state.lastSharedSnapshotR2Key),
    );
  return {
    ...meeting,
    canManageMeeting,
    hasWhiteboardState,
    whiteboardCaptureState: deriveWhiteboardCaptureState({
      hasWhiteboardState,
      captureStatuses: documentStates.map((state) => state.captureStatus),
    }),
    hasWhiteboardPdf: artifactTypes.has("whiteboard_pdf"),
    hasRecording: artifactTypes.has("recording"),
    recording,
    whiteboardsShown: toWhiteboardsShown(documentStates),
  };
}

export async function getEndedMeetingImpl({
  data,
  context: { user, db, env },
}: {
  data: MeetingLocatorInput;
  context: AuthFnContext;
}) {
  const resolved = await resolveAccessibleMeeting(db, user.id, data.meetingId);
  if (!resolved) return { meeting: null, summary: null, summaryState: null };

  // The Meeting enrichment and latest-Summary lookup are independent, so
  // they overlap. The transcript snapshot is already on `resolved` — read
  // from the same Meeting row — so Summary freshness costs no extra round-trip.
  const [meeting, row, followUps] = await Promise.all([
    buildEndedMeeting(db, resolved, user.id),
    db
      .select({
        id: meetingSummaries.id,
        summary: meetingSummaries.summary,
        moments: meetingSummaries.moments,
        durationSeconds: meetingSummaries.durationSeconds,
        participantCount: meetingSummaries.participantCount,
        transcribedParticipantCount: meetingSummaries.transcribedParticipantCount,
        transcriptSegmentCount: meetingSummaries.transcriptSegmentCount,
        transcriptLastUpdatedAt: meetingSummaries.transcriptLastUpdatedAt,
        createdAt: meetingSummaries.createdAt,
      })
      .from(meetingSummaries)
      .where(eq(meetingSummaries.meetingId, resolved.meeting.meetingId))
      .orderBy(desc(meetingSummaries.createdAt))
      .get(),
    selectMeetingFollowUps(db, resolved.meeting.meetingId),
  ]);

  const snapshot = resolved.transcriptSnapshot;
  const currentRow = row && summaryMatchesTranscriptSnapshot(row, snapshot) ? row : null;

  return {
    meeting: { ...meeting, hasTranscript: snapshot.segmentCount > 0 },
    summary: currentRow,
    // Follow-ups outlive a stale Summary: what people agreed to do, and what
    // they have done since, is still true when the transcript grows.
    followUps,
    summaryState: summaryStateOf({
      hasCurrentSummary: currentRow !== null,
      ...resolved.summary,
      configured: isSummaryGenerationConfigured(env),
    }),
  };
}

export async function getLatestMeetingTranscriptsImpl({
  data,
  context: { user, db },
}: {
  data: MeetingTranscriptsInput;
  context: AuthFnContext;
}) {
  const resolved = await resolveAccessibleMeeting(db, user.id, data.meetingId);
  if (!resolved) return { transcripts: [], nextCursor: null };

  return listTranscriptRowsPage(db, resolved.meeting.meetingId, {
    cursor: data.cursor ?? null,
    limit: data.limit ?? DEFAULT_TRANSCRIPT_PAGE_SIZE,
  });
}
