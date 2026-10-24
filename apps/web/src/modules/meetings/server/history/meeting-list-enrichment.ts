import type { Database } from "@orbmeet/db";
import {
  meetingAdmissions,
  meetingArtifacts,
  meetingConnections,
  meetingWhiteboards,
} from "@orbmeet/db/schema";
import { and, asc, countDistinct, eq, inArray, isNotNull, lte, or, sql } from "drizzle-orm";
import { boundedStatements } from "@/platform/database/db-batching";
import {
  admissionParticipantKeySql,
  connectionIsPresent,
  connectionParticipantKeySql,
} from "@/modules/meetings/server/connection/state";

export async function selectParticipantDisplayNames(
  db: Database,
  meetingIds: string[],
): Promise<Array<{ meetingId: string; displayName: string }>> {
  // row_number() partitions by meeting and each meeting's rows fall entirely
  // within one statement's ids, so the per-meeting ranking stays correct
  // however the ids are split.
  const lookups = boundedStatements(meetingIds, (chunk) => {
    // Each participant's first admission, so someone who rejoined — or joined
    // from two devices — is named once, under the name they first joined with.
    const firstAdmissions = db
      .select({
        meetingId: meetingAdmissions.meetingId,
        displayName: meetingAdmissions.displayName,
        createdAt: meetingAdmissions.createdAt,
        admissionId: sql<string>`${meetingAdmissions.id}`.as("admission_id"),
        admissionRank: sql<number>`row_number() over (
          partition by ${meetingAdmissions.meetingId}, ${admissionParticipantKeySql()}
          order by ${meetingAdmissions.createdAt}, ${meetingAdmissions.id}
        )`.as("admission_rank"),
      })
      .from(meetingAdmissions)
      .where(
        and(
          inArray(meetingAdmissions.meetingId, chunk),
          eq(meetingAdmissions.admissionStatus, "approved"),
        ),
      )
      .as("first_admissions");

    const rankedParticipants = db
      .select({
        meetingId: firstAdmissions.meetingId,
        displayName: firstAdmissions.displayName,
        participantRank: sql<number>`row_number() over (
          partition by ${firstAdmissions.meetingId}
          order by ${firstAdmissions.createdAt}, ${firstAdmissions.admissionId}
        )`.as("participant_rank"),
      })
      .from(firstAdmissions)
      .where(eq(firstAdmissions.admissionRank, 1))
      .as("ranked_participants");

    return db
      .select({
        meetingId: rankedParticipants.meetingId,
        displayName: rankedParticipants.displayName,
      })
      .from(rankedParticipants)
      .where(lte(rankedParticipants.participantRank, 6))
      .orderBy(
        asc(rankedParticipants.meetingId),
        asc(rankedParticipants.participantRank),
      );
  });
  return (await Promise.all(lookups)).flat();
}

/** Admitted participants per meeting (not admissions: see `admissionParticipantKeySql`). */
export async function selectApprovedAdmissionCounts(
  db: Database,
  meetingIds: string[],
): Promise<Array<{ meetingId: string; count: number }>> {
  const lookups = boundedStatements(meetingIds, (chunk) =>
    db
      .select({
        meetingId: meetingAdmissions.meetingId,
        count: countDistinct(admissionParticipantKeySql()),
      })
      .from(meetingAdmissions)
      .where(
        and(
          inArray(meetingAdmissions.meetingId, chunk),
          eq(meetingAdmissions.admissionStatus, "approved"),
        ),
      )
      .groupBy(meetingAdmissions.meetingId));
  return (await Promise.all(lookups)).flat();
}

/** Participants LiveKit reports in the room now, per meeting. */
export async function selectLiveConnectionCounts(
  db: Database,
  meetingIds: string[],
): Promise<Array<{ meetingId: string; count: number }>> {
  const lookups = boundedStatements(meetingIds, (chunk) =>
    db
      .select({
        meetingId: meetingConnections.meetingId,
        count: countDistinct(connectionParticipantKeySql()),
      })
      .from(meetingConnections)
      .where(
        and(
          inArray(meetingConnections.meetingId, chunk),
          connectionIsPresent(),
        ),
      )
      .groupBy(meetingConnections.meetingId));
  return (await Promise.all(lookups)).flat();
}

/** Whiteboard/recording artifact types present per meeting. */
export async function selectMeetingArtifactTypes(
  db: Database,
  meetingIds: string[],
): Promise<Array<{ meetingId: string; type: string }>> {
  const artifactLookups = boundedStatements(meetingIds, (chunk) =>
    db
      .select({ meetingId: meetingArtifacts.meetingId, type: meetingArtifacts.type })
      .from(meetingArtifacts)
      .where(inArray(meetingArtifacts.meetingId, chunk)));
  const documentLookups = boundedStatements(meetingIds, (chunk) =>
    db
      .select({ meetingId: meetingWhiteboards.meetingId })
      .from(meetingWhiteboards)
      .where(and(
        inArray(meetingWhiteboards.meetingId, chunk),
        or(
          isNotNull(meetingWhiteboards.lastSharedSnapshotR2Key),
          isNotNull(meetingWhiteboards.capturedRevisionId),
        ),
      )));
  const [artifacts, documents] = await Promise.all([
    Promise.all(artifactLookups),
    Promise.all(documentLookups),
  ]);
  return [
    ...artifacts.flat(),
    // Not an artifact row: the meeting has board state through its documents.
    ...documents.flat().map((row) => ({ meetingId: row.meetingId, type: "board_state" })),
  ];
}

/** Partition artifact rows into per-type meeting-id sets. */
export function partitionArtifactsByType(artifacts: Array<{ meetingId: string; type: string }>): {
  whiteboardState: Set<string>;
  whiteboardPdf: Set<string>;
  recording: Set<string>;
} {
  const whiteboardState = new Set<string>();
  const whiteboardPdf = new Set<string>();
  const recording = new Set<string>();
  for (const a of artifacts) {
    switch (a.type) {
      case "board_state":
        whiteboardState.add(a.meetingId);
        break;
      case "whiteboard_pdf":
        whiteboardPdf.add(a.meetingId);
        break;
      case "recording":
        recording.add(a.meetingId);
        break;
    }
  }
  return { whiteboardState, whiteboardPdf, recording };
}

/**
 * Bucket participant display names by meeting, capping each meeting's list at
 * the given limit. Single pass; the rows are already ranked/ordered upstream
 * (selectParticipantDisplayNames), so we preserve ordering by taking the first
 * `limit` per meeting.
 */
export function bucketParticipantNames(
  admissions: Array<{ meetingId: string; displayName: string }>,
  maxPerMeeting = 5,
): Map<string, string[]> {
  // A list says who was there, so a name is said once: two admissions under
  // one name — the same person signed in and as a guest, on two devices — read
  // as a repeat, not as two people.
  const byMeeting = new Map<string, string[]>();
  for (const a of admissions) {
    const names = byMeeting.get(a.meetingId);
    if (names === undefined) {
      byMeeting.set(a.meetingId, [a.displayName]);
    } else if (names.length < maxPerMeeting && !names.includes(a.displayName)) {
      names.push(a.displayName);
    }
  }
  return byMeeting;
}
