/**
 * Server implementations behind the RPC declarations in this directory.
 * Split from the sibling RPC file so the declaration file carries no
 * DB/Drizzle imports and stays safe to include in client route graphs.
 */

import type { Database } from "@orbmeet/db";
import { meetingSummaries, meetingWhiteboardPages, meetingWhiteboards, whiteboardRevisions, whiteboards } from "@orbmeet/db/schema";
import { filterCapturedHandoutPageIds } from "@/modules/whiteboards/server/handout-pages";
import { Errors } from "@/lib/app-errors";
import { verifyGuestSecret } from "@/platform/crypto/tokens.server";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { canAccessMeetingHistory } from "@/modules/meetings/server/access/resource-access";
import { getTranscriptSnapshot, summaryMatchesTranscriptSnapshot } from "@/modules/transcripts/server/generate-summary.server";
import type { RequestFnContext } from "@/app/bootstrap/middleware";
import { getGuestCookieSecret } from "@/modules/meetings/server/access/guest-cookie.server";
import { enforceRateLimit } from "@/platform/http/rate-limit.server";
import { isSummaryGenerationConfigured } from "@/modules/meetings/server/history/summary-generation-policy";
import { readStoredSnapshot } from "@/modules/whiteboards/server/sync-commands.server";
import type { WhiteboardSnapshotExport } from "@/modules/whiteboards/server/export.server";
import type { ParticipantHandoffInput } from "./participant-handoff.functions";
import type { ParticipantHandoffWhiteboardInput } from "./participant-handoff.functions";
import { summaryStateOf } from "./summary-state";

async function listParticipantHandoffWhiteboards(db: Database, meetingId: string) {
  const rows = await db
    .select({
      whiteboardId: meetingWhiteboards.whiteboardId,
      title: meetingWhiteboards.titleAtEnd,
      revisionId: meetingWhiteboards.capturedRevisionId,
      capturedAt: meetingWhiteboards.capturedAt,
    })
    .from(meetingWhiteboards)
    .where(
      and(
        eq(meetingWhiteboards.meetingId, meetingId),
        eq(meetingWhiteboards.captureStatus, "captured"),
      ),
    )
    .orderBy(asc(meetingWhiteboards.attachedAt));
  return rows.flatMap((row) =>
    row.revisionId
      ? [
          {
            ...row,
            title: row.title ?? "Whiteboard",
            revisionId: row.revisionId,
            capturedAt: row.capturedAt?.toISOString() ?? null,
          },
        ]
      : [],
  );
}

function projectParticipantHandoffSummary(summary: {
  id: string;
  summary: string;
  durationSeconds: number | null;
  participantCount: number | null;
  transcribedParticipantCount: number | null;
  createdAt: Date;
}) {
  return {
    id: summary.id,
    summary: summary.summary,
    durationSeconds: summary.durationSeconds,
    participantCount: summary.participantCount,
    transcribedParticipantCount: summary.transcribedParticipantCount,
    createdAt: summary.createdAt,
  };
}

export async function assertParticipantHandoffAccess(
  db: Database,
  user: { id: string } | null,
  meetingId: string,
  admissionId: string,
): Promise<void> {
  if (user && (await canAccessMeetingHistory(db, meetingId, user.id))) return;

  // Signing in does not end a guest's claim: someone who joined as a guest and
  // then signed in on the same browser still holds the admission's cookie.
  const guestSecret = getGuestCookieSecret(admissionId);
  if (!guestSecret) throw user ? Errors.FORBIDDEN() : Errors.UNAUTHORIZED();

  const admission = await db.query.meetingAdmissions.findFirst({
    where: {
      RAW: (row) =>
        and(
          eq(row.id, admissionId),
          eq(row.meetingId, meetingId),
          eq(row.subjectType, "guest"),
          eq(row.admissionStatus, "approved"),
          isNull(row.subjectUserId),
        )!,
    },
    columns: { guestSecretHash: true },
  });

  if (!admission?.guestSecretHash) throw Errors.FORBIDDEN();
  if (!(await verifyGuestSecret(admission.guestSecretHash, guestSecret))) throw Errors.FORBIDDEN();
}

export async function getParticipantHandoffSummaryImpl({
  data,
  context: { env, db, user, clientIP },
}: {
  data: ParticipantHandoffInput;
  context: RequestFnContext;
}) {
  await enforceRateLimit(env, `summary:get:${clientIP}`);

  const meeting = await db.query.meetings.findFirst({
    where: { id: data.meetingId },
    columns: {
      id: true,
      status: true,
      retainUntil: true,
      summaryStatus: true,
      summarySkipReason: true,
    },
  });
  if (!meeting) throw Errors.NOT_FOUND("Meeting");

  await assertParticipantHandoffAccess(db, user, meeting.id, data.admissionId);
  const whiteboards = await listParticipantHandoffWhiteboards(db, meeting.id);

  const row = await db
    .select({
      id: meetingSummaries.id,
      summary: meetingSummaries.summary,
      durationSeconds: meetingSummaries.durationSeconds,
      participantCount: meetingSummaries.participantCount,
      transcribedParticipantCount: meetingSummaries.transcribedParticipantCount,
      transcriptSegmentCount: meetingSummaries.transcriptSegmentCount,
      transcriptLastUpdatedAt: meetingSummaries.transcriptLastUpdatedAt,
      createdAt: meetingSummaries.createdAt,
    })
    .from(meetingSummaries)
    .where(eq(meetingSummaries.meetingId, meeting.id))
    .orderBy(desc(meetingSummaries.createdAt))
    .get();

  if (meeting.status !== "ended") {
    return { status: "active" as const, summary: null, whiteboards, retainUntil: null };
  }

  // A summary written for an earlier transcript is not this meeting's
  // summary, so a stale row reads exactly as no row: whether one is still
  // coming depends only on the meeting's Summary status. Deciding the stale
  // case separately answered "pending" after a final outcome, forever.
  const current = row && summaryMatchesTranscriptSnapshot(row, await getTranscriptSnapshot(db, meeting.id))
    ? row
    : null;
  if (!current) {
    const state = summaryStateOf({
      hasCurrentSummary: false,
      summaryStatus: meeting.summaryStatus,
      summarySkipReason: meeting.summarySkipReason,
      configured: isSummaryGenerationConfigured(env),
    });
    return {
      status: state.status === "pending" ? ("pending" as const) : ("unavailable" as const),
      summary: null,
      whiteboards,
      retainUntil: meeting.retainUntil?.toISOString() ?? null,
    };
  }

  return {
    status: "ready" as const,
    summary: projectParticipantHandoffSummary(current),
    whiteboards,
    retainUntil: meeting.retainUntil?.toISOString() ?? null,
  };
}

export async function getParticipantHandoffWhiteboardImpl({
  data,
  context: { env, db, user, clientIP },
}: {
  data: ParticipantHandoffWhiteboardInput;
  context: RequestFnContext;
}) {
  await enforceRateLimit(env, `whiteboard:get:${clientIP}`);
  await assertParticipantHandoffAccess(db, user, data.meetingId, data.admissionId);
  const [captured] = await db
    .select({
      meetingWhiteboardId: meetingWhiteboards.id,
      revisionId: whiteboardRevisions.id,
      r2Key: whiteboardRevisions.snapshotR2Key,
    })
    .from(meetingWhiteboards)
    .innerJoin(
      whiteboardRevisions,
      eq(whiteboardRevisions.id, meetingWhiteboards.capturedRevisionId),
    )
    .innerJoin(whiteboards, eq(whiteboards.id, meetingWhiteboards.whiteboardId))
    .where(
      and(
        eq(meetingWhiteboards.meetingId, data.meetingId),
        eq(meetingWhiteboards.whiteboardId, data.whiteboardId),
      ),
    )
    .limit(1);
  if (!captured) throw Errors.NOT_FOUND("Meeting Whiteboard version");
  const snapshot = await readStoredSnapshot<WhiteboardSnapshotExport>(
    env,
    captured.r2Key,
  );
  if (!snapshot) throw Errors.NOT_FOUND("Meeting Whiteboard version");
  const pages = await db
    .select({ pageId: meetingWhiteboardPages.pageId })
    .from(meetingWhiteboardPages)
    .where(eq(meetingWhiteboardPages.meetingWhiteboardId, captured.meetingWhiteboardId))
    .orderBy(asc(meetingWhiteboardPages.handoutOrder));
  return {
    revisionId: captured.revisionId,
    pageIds: filterCapturedHandoutPageIds(
      snapshot,
      pages.map((page) => page.pageId),
    ),
    snapshot,
  };
}

