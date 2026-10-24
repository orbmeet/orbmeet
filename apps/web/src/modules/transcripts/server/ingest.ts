import "@tanstack/react-start/server-only";
import { type Database } from "@orbmeet/db";
import { meetingAdmissions, meetingConnections, transcripts } from "@orbmeet/db/schema";
import { boundedStatements } from "@/platform/database/db-batching";
import { DISCONNECTED_TRANSCRIPT_GRACE_MS } from "@/modules/meetings/contract/constants";
import { generateId } from "@/lib/ids";
import { and, eq, inArray, isNotNull, or } from "drizzle-orm";
import type { TranscriptIngest } from "@orbmeet/caption-protocol/transcript-ingest";
import { getRunChanges, withD1Retry } from "@/platform/database/db-utils";
import { requestMeetingSummary, summaryMissesCommittedTranscript } from "./summary-jobs";
import { connectionIsEnded, connectionIsUnfinished } from "@/modules/meetings/server/connection/state";

export type IngestTranscriptsInput = TranscriptIngest;

export async function findTranscriptionParticipant(
  db: Database,
  meetingId: string,
  participantIdentity: string,
) {
  const rows = await db
    .select({
      admissionId: meetingAdmissions.id,
      connectionId: meetingConnections.id,
      displayName: meetingAdmissions.displayName,
      livekitIdentity: meetingConnections.livekitIdentity,
      connectionStatus: meetingConnections.connectionStatus,
      disconnectedAt: meetingConnections.disconnectedAt,
      tokenIssuedAt: meetingConnections.tokenIssuedAt,
    })
    .from(meetingConnections)
    .innerJoin(
      meetingAdmissions,
      and(
        eq(meetingAdmissions.id, meetingConnections.admissionId),
        eq(meetingAdmissions.meetingId, meetingConnections.meetingId),
      ),
    )
    .where(
      and(
        eq(meetingConnections.meetingId, meetingId),
        eq(meetingConnections.livekitIdentity, participantIdentity),
        // Speech is attributed to who said it, not to what was decided about
        // them since: a participant removed after speaking stays its speaker
        // however long delivery took. A connection that reached the room did
        // so under an approved admission, and removal ends it at once, so a
        // revoked admission names nobody who was not there.
        inArray(meetingAdmissions.admissionStatus, ["approved", "revoked"]),
        or(
          connectionIsUnfinished(),
          // An `ended` connection that was actually live remains a valid
          // attribution target for the durable outbox. Delivery can be delayed
          // arbitrarily by an app/auth outage; imposing a wall-clock grace here
          // made otherwise-valid pending speech expire before it reached D1.
          // A never-connected `ended` row produced no audio and stays excluded.
          and(
            connectionIsEnded(),
            isNotNull(meetingConnections.connectedAt),
          ),
        ),
      ),
    );

  return rows.sort((a, b) => b.tokenIssuedAt.getTime() - a.tokenIssuedAt.getTime())[0] ?? null;
}

/**
 * How far past a meeting's own end a segment may still claim to have started.
 * Covers the transcription flush that follows the last participant leaving.
 */
const TRANSCRIPT_START_GRACE_MS = DISCONNECTED_TRANSCRIPT_GRACE_MS;

/**
 * Confine a segment's claimed start time to the meeting it belongs to.
 *
 * `startedAt` is supplied by the caller and was only ever clamped forward
 * (`Math.min(startedAt, now)`), so any time in the past was accepted verbatim —
 * a segment could be filed years before the meeting existed, reordering
 * scrollback and the summary around it. The meeting's own window is the
 * authoritative bound, and clamping rather than rejecting keeps a merely
 * skewed clock from discarding real speech.
 */
export function clampSegmentStartedAt(
  startedAt: number,
  meeting: { startedAt: Date; endedAt: Date | null },
  now: Date,
): Date {
  const earliest = meeting.startedAt.getTime();
  const latest = Math.min(
    now.getTime(),
    meeting.endedAt ? meeting.endedAt.getTime() + TRANSCRIPT_START_GRACE_MS : now.getTime(),
  );
  // A meeting that ended before it started is not representable, but `latest`
  // can still fall below `earliest` if the clocks disagree; prefer the window's
  // start so the row stays inside the meeting.
  return new Date(Math.max(earliest, Math.min(startedAt, Math.max(earliest, latest))));
}

export function buildDeepgramTranscriptRows(
  input: IngestTranscriptsInput,
  participant: {
    admissionId: string;
    connectionId: string;
    displayName: string;
    livekitIdentity: string;
  },
  meeting: { startedAt: Date; endedAt: Date | null },
) {
  const now = new Date();
  return input.segments.map((segment) => ({
    id: generateId("TRANSCRIPT"),
    meetingId: input.meetingId,
    admissionId: participant.admissionId,
    connectionId: participant.connectionId,
    participantIdentity: participant.livekitIdentity,
    participantName: participant.displayName,
    text: segment.text,
    segmentId: `deepgram:${segment.segmentId}`,
    language: segment.language ?? null,
    // The VPS and Worker clocks are independently synchronized. Clamping keeps
    // the capture second at or before the ingest second (the DB checks it)
    // under skew — which would otherwise reject a valid batch and block every
    // later segment behind it — and confines the caller-supplied time to the
    // meeting's own window. The capture time keeps its milliseconds: it is
    // what orders overlapping speakers.
    startedAt: clampSegmentStartedAt(segment.startedAt, meeting, now),
    updatedAt: now,
  }));
}

export async function ingestDeepgramTranscripts(
  db: Database,
  env: Env,
  input: IngestTranscriptsInput,
): Promise<{ submitted: number }> {
  const participant = await findTranscriptionParticipant(
    db,
    input.meetingId,
    input.participantIdentity,
  );
  if (!participant) return { submitted: 0 };

  const meeting = await db.query.meetings.findFirst({
    where: { id: input.meetingId },
    columns: { startedAt: true, endedAt: true },
  });
  if (!meeting) return { submitted: 0 };

  const rows = buildDeepgramTranscriptRows(input, participant, meeting);
  let insertedSegments = 0;
  for (const insert of boundedStatements(rows, (chunk) =>
    db.insert(transcripts).values(chunk).onConflictDoNothing())) {
    const result = await withD1Retry(() => insert, { idempotent: true });
    insertedSegments += getRunChanges(result);
  }

  // D1 maintains the Meeting projection with an AFTER INSERT trigger in the
  // same transaction as each segment. Conflict-skipped retries do not fire it,
  // so there is no second write to lose and no historical transcript scan.
  //
  // A meeting may end before the transcription outbox reaches the Worker, so
  // late text owes a new Summary. So does a delivery whose rows were all
  // conflict-skipped when the request that wrote them failed before owing it;
  // a replay whose Summary already covers every committed segment owes none.
  // `requestMeetingSummary` only acts on an ended meeting; while one runs, its
  // end owes the Summary.
  const needsSummary = insertedSegments > 0
    || await summaryMissesCommittedTranscript(db, input.meetingId);
  if (needsSummary) {
    await requestMeetingSummary(db, env, input.meetingId);
  }
  return { submitted: rows.length };
}
