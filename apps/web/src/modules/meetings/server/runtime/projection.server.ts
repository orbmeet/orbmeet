import type { Database } from "@orbmeet/db";
import {
  meetingAdmissions,
  meetingConnections,
  meetings,
  meetingWhiteboards,
  meetingWhiteboardSurfaces,
  users,
} from "@orbmeet/db/schema";
import { and, eq, isNotNull, ne, sql, type SQL } from "drizzle-orm";
import type { BatchStatement } from "@/platform/database/db-batching";
import { beginMeetingCloseStatement } from "../lifecycle/finalize";
import { connectionStatusOf } from "../connection/state";
import { roleOf, type Admission, type Attempt, type MeetingState } from "./model";

const seconds = (ms: number) => Math.floor(ms / 1000);

/**
 * The D1 rows that differ between two states of a meeting, written as their
 * current state: the meeting row, `meeting_admissions`,
 * `meeting_connections` (one row per attempt, never reissued), and the
 * whiteboard surface (`meeting_whiteboard_surfaces` and which
 * `meeting_whiteboards` row is focused). Everything
 * else in the app reads these tables; the meeting's MeetingRoom is their only
 * writer, and writes them before it keeps the state they came from, so a
 * reply never promises what D1 does not yet show.
 *
 * Rows are found by comparing what each state projects, so no transition has
 * to remember to mark what it touched. A row whose parent is gone (a deleted
 * user's admissions cascade away, a deleted meeting takes its rows) is
 * skipped rather than failing the batch.
 */
export function projectMeetingChanges(
  db: Database,
  before: MeetingState | null,
  after: MeetingState,
  now: number,
): BatchStatement[] {
  const statements: BatchStatement[] = [];
  if (!before || !sameJson(meetingRowOf(before), meetingRowOf(after))) {
    statements.push(meetingUpdate(db, after, now));
  }
  const ended = (state: MeetingState | null) => state?.meta.phase === "ended" || state?.meta.phase === "drained";
  if (ended(after) && !ended(before)) {
    statements.push(beginMeetingCloseStatement(db, after.meta.meetingId, new Date(now)));
  }
  // A room's first change may be a rename (an admin renaming an open meeting
  // nobody has joined yet), so with nothing projected before the title goes too.
  if (!before || before.meta.title !== after.meta.title) {
    statements.push(titleUpdate(db, after, now));
  }
  statements.push(...surfaceChanges(db, before, after, now));
  for (const admission of Object.values(after.admissions)) {
    if (!sameJson(before?.admissions[admission.id], admission)) {
      statements.push(admissionUpsert(db, after.meta.meetingId, admission));
    }
  }
  for (const attempt of Object.values(after.attempts)) {
    const admission = after.admissions[attempt.admissionId];
    if (!admission) continue;
    if (!sameJson(before ? connectionRowOf(before, attempt.id) : undefined, connectionRowOf(after, attempt.id))) {
      statements.push(attemptUpsert(db, after, attempt, admission, now));
    }
  }
  return statements;
}

/** The meeting row's columns this projection owns. */
function meetingRowOf(state: MeetingState) {
  const { meta, egress } = state;
  return [
    meta.joinPolicy,
    meta.transcription,
    meta.nodeId,
    meta.firstJoinedAt,
    egress.mode,
    egress.egressId,
    egress.revision,
  ];
}

/** An attempt's connection row: its own fields and the role its admission resolves to. */
function connectionRowOf(state: MeetingState, attemptId: string) {
  const attempt = state.attempts[attemptId];
  const admission = attempt ? state.admissions[attempt.admissionId] : undefined;
  if (!attempt || !admission) return undefined;
  return [
    connectionStatusOf(attempt), attempt.sid, attempt.endReason, attempt.joinedAt, attempt.endedAt,
    roleOf(state, admission), admission.userId,
  ];
}

/**
 * The surface row, and focus moved onto the presented board. Both are written
 * only while the meeting is open in D1: finalization deletes the surface and
 * the capture clears focus.
 */
function surfaceChanges(db: Database, before: MeetingState | null, after: MeetingState, now: number): BatchStatement[] {
  const previous = before?.surface;
  const surface = after.surface;
  const statements: BatchStatement[] = [];
  const meetingOpen = sql`exists (
    select 1 from ${meetings}
    where ${meetings.id} = ${after.meta.meetingId} and ${meetings.status} = 'open'
  )`;
  if (previous?.open !== surface.open || previous?.revision !== surface.revision) {
    statements.push(
      db
        .insert(meetingWhiteboardSurfaces)
        .select(
          db
            .select({
              meetingId: sql`${after.meta.meetingId}`.as("meeting_id"),
              open: sql`${surface.open ? 1 : 0}`.as("open"),
              revision: sql`${surface.revision}`.as("revision"),
              updatedAt: sql`${seconds(now)}`.as("updated_at"),
            })
            .from(sql`(select 1)`)
            .where(meetingOpen),
        )
        .onConflictDoUpdate({
          target: meetingWhiteboardSurfaces.meetingId,
          set: {
            open: sql`excluded.open`,
            revision: sql`excluded.revision`,
            updatedAt: sql`excluded.updated_at`,
          },
        }),
    );
  }
  const focus = surface.focus;
  const presented = focus && (
    previous?.focus?.usageId !== focus.usageId || (surface.open && !previous?.open)
  );
  if (focus && presented) {
    // Focus is unique per meeting, so the previous row is cleared first.
    statements.push(
      db
        .update(meetingWhiteboards)
        .set({ focusedAt: null })
        .where(and(
          eq(meetingWhiteboards.meetingId, after.meta.meetingId),
          ne(meetingWhiteboards.id, focus.usageId),
          isNotNull(meetingWhiteboards.focusedAt),
          meetingOpen,
        )),
      db
        .update(meetingWhiteboards)
        .set({ focusedAt: new Date(now), lastPresentedAt: new Date(now) })
        .where(and(
          eq(meetingWhiteboards.id, focus.usageId),
          eq(meetingWhiteboards.meetingId, after.meta.meetingId),
          meetingOpen,
        )),
    );
  }
  return statements;
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function meetingUpdate(db: Database, state: MeetingState, now: number) {
  const { meta, egress } = state;
  const recordingId = egress.mode === "recording" ? egress.egressId : null;
  const streamId = egress.mode === "streaming" ? egress.egressId : null;
  // An ended meeting carries no egress ids (meetings_ended_egress_cleared_check).
  const whileOpen = (value: string | null): SQL =>
    sql`case when ${meetings.status} = 'open' then ${value} else null end`;
  return db
    .update(meetings)
    .set({
      joinPolicy: meta.joinPolicy,
      transcriptionEnabled: meta.transcription,
      mediaNodeId: meta.nodeId,
      firstJoinedAt: meta.firstJoinedAt === null
        ? sql`${meetings.firstJoinedAt}`
        : sql`coalesce(${meetings.firstJoinedAt}, ${seconds(meta.firstJoinedAt)})`,
      activeEgressId: whileOpen(recordingId),
      activeStreamEgressId: whileOpen(streamId),
      egressStateRevision: sql`max(${meetings.egressStateRevision}, ${egress.revision})`,
      updatedAt: sql`max(${meetings.updatedAt}, ${seconds(now)})`,
    })
    .where(eq(meetings.id, meta.meetingId));
}

/**
 * The title is written on its own and only while the meeting is open: once it
 * ends, the summary job may name an untitled meeting, and a later write of the
 * room's state must not undo that.
 */
function titleUpdate(db: Database, state: MeetingState, now: number) {
  return db
    .update(meetings)
    .set({ title: state.meta.title, updatedAt: sql`max(${meetings.updatedAt}, ${seconds(now)})` })
    .where(and(eq(meetings.id, state.meta.meetingId), eq(meetings.status, "open")));
}

function admissionUpsert(db: Database, meetingId: string, admission: Admission) {
  // A meeting deleted under its coordinator (account or Space removal) takes
  // its rows with it; there is nothing left to project.
  const parentsExist = sql`exists (select 1 from ${meetings} where ${meetings.id} = ${meetingId})
    and ${admission.userId === null
      ? sql`1 = 1`
      : sql`exists (select 1 from ${users} where ${users.id} = ${admission.userId})`}`;
  const decidedBy = admission.decidedByUserId === null
    ? sql`null`
    : sql`(select ${users.id} from ${users} where ${users.id} = ${admission.decidedByUserId})`;
  return db
    .insert(meetingAdmissions)
    .select(
      db
        .select({
          id: sql`${admission.id}`.as("id"),
          meetingId: sql`${meetingId}`.as("meeting_id"),
          subjectType: sql`${admission.userId === null ? "guest" : "user"}`.as("subject_type"),
          subjectUserId: sql`${admission.userId}`.as("subject_user_id"),
          guestSecretHash: sql`${admission.guestSecretHash}`.as("guest_secret_hash"),
          displayName: sql`${admission.displayName}`.as("display_name"),
          admissionStatus: sql`${admission.status}`.as("admission_status"),
          decisionReason: sql`${admission.decisionReason}`.as("decision_reason"),
          decidedByUserId: decidedBy.as("decided_by_user_id"),
          decidedAt: sql`${admission.decidedAt === null ? null : seconds(admission.decidedAt)}`.as("decided_at"),
          screenShareGranted: sql`${admission.screenShare === "granted" ? 1 : 0}`.as("screen_share_granted"),
          whiteboardEditGranted: sql`${admission.boardEdit ? 1 : 0}`.as("whiteboard_edit_granted"),
          meetingModerator: sql`${admission.moderator ? 1 : 0}`.as("meeting_moderator"),
          createdAt: sql`${seconds(admission.createdAt)}`.as("created_at"),
          updatedAt: sql`${seconds(admission.updatedAt)}`.as("updated_at"),
        })
        .from(sql`(select 1)`)
        .where(parentsExist),
    )
    .onConflictDoUpdate({
      target: meetingAdmissions.id,
      set: {
        displayName: sql`excluded.display_name`,
        admissionStatus: sql`excluded.admission_status`,
        decisionReason: sql`excluded.decision_reason`,
        decidedByUserId: sql`excluded.decided_by_user_id`,
        decidedAt: sql`excluded.decided_at`,
        screenShareGranted: sql`excluded.screen_share_granted`,
        whiteboardEditGranted: sql`excluded.whiteboard_edit_granted`,
        meetingModerator: sql`excluded.meeting_moderator`,
        updatedAt: sql`max(${meetingAdmissions.updatedAt}, excluded.updated_at)`,
      },
    });
}

function attemptUpsert(
  db: Database,
  state: MeetingState,
  attempt: Attempt,
  admission: Admission,
  now: number,
) {
  const { meetingId } = state.meta;
  const status = connectionStatusOf(attempt);
  const parentExists = sql`exists (
    select 1 from ${meetingAdmissions}
    where ${meetingAdmissions.id} = ${attempt.admissionId}
      and ${meetingAdmissions.meetingId} = ${meetingId}
  )`;
  const userExists = admission.userId === null
    ? sql`1 = 1`
    : sql`exists (select 1 from ${users} where ${users.id} = ${admission.userId})`;
  return db
    .insert(meetingConnections)
    .select(
      db
        .select({
          id: sql`${attempt.id}`.as("id"),
          meetingId: sql`${meetingId}`.as("meeting_id"),
          admissionId: sql`${attempt.admissionId}`.as("admission_id"),
          livekitIdentity: sql`${attempt.identity}`.as("livekit_identity"),
          livekitParticipantSid: sql`${attempt.sid}`.as("livekit_participant_sid"),
          userId: sql`${admission.userId}`.as("user_id"),
          role: sql`${roleOf(state, admission)}`.as("role"),
          connectionStatus: sql`${status}`.as("connection_status"),
          reason: sql`${attempt.endReason}`.as("reason"),
          tokenIssuedAt: sql`${seconds(attempt.issuedAt)}`.as("token_issued_at"),
          connectedAt: sql`${attempt.joinedAt === null ? null : seconds(attempt.joinedAt)}`.as("connected_at"),
          disconnectedAt: sql`${attempt.endedAt === null ? null : seconds(attempt.endedAt)}`.as("disconnected_at"),
          lastWebhookAt: sql`null`.as("last_webhook_at"),
          createdAt: sql`${seconds(attempt.issuedAt)}`.as("created_at"),
          updatedAt: sql`${seconds(Math.max(now, attempt.issuedAt))}`.as("updated_at"),
        })
        .from(sql`(select 1)`)
        .where(sql`${parentExists} and ${userExists}`),
    )
    .onConflictDoUpdate({
      target: meetingConnections.id,
      set: {
        livekitParticipantSid: sql`excluded.livekit_participant_sid`,
        role: sql`excluded.role`,
        connectionStatus: sql`excluded.connection_status`,
        reason: sql`excluded.reason`,
        connectedAt: sql`excluded.connected_at`,
        disconnectedAt: sql`excluded.disconnected_at`,
        updatedAt: sql`max(${meetingConnections.updatedAt}, excluded.updated_at)`,
      },
    });
}
