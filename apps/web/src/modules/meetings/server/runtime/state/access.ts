import { Errors } from "@/lib/app-errors";
import {
  canManage,
  canModerate,
  grantFor,
  holdsSeat,
  isOpen,
  roleOf,
  roomMetadataFor,
  tokenExpiresAt,
  type Admission,
  type Attempt,
  type MeetingState,
} from "../model";
import type { EgressView, ParticipantView, Subject } from "../protocol";

export function ownsAdmission(subject: Subject, admission: Admission): boolean {
  switch (subject.kind) {
    case "user":
      return admission.userId === subject.userId;
    case "guest":
      return admission.userId === null && subject.admissionId === admission.id && subject.verified;
    case "system":
      return false;
  }
}

/** A user's newest admission still waiting or admitted, if any. */
export function liveAdmissionOf(state: MeetingState, userId: string): Admission | undefined {
  let live: Admission | undefined;
  for (const admission of Object.values(state.admissions)) {
    if (admission.userId !== userId) continue;
    if (admission.status !== "pending" && admission.status !== "approved") continue;
    if (!live || admission.createdAt > live.createdAt) live = admission;
  }
  return live;
}

/** Whether `attemptId` is one of the subject's own attempts that pruning forgot. */
export function ownPrunedAttempt(state: MeetingState, subject: Subject, attemptId: string): boolean {
  const admissionId = state.attempts[attemptId] ? undefined : state.prunedAttempts[attemptId]?.admissionId;
  const admission = admissionId ? state.admissions[admissionId] : undefined;
  if (!admission) return false;
  if (!ownsAdmission(subject, admission)) throw Errors.FORBIDDEN();
  return true;
}

export function ownAttempt(state: MeetingState, subject: Subject, attemptId: string): Attempt {
  // A forgotten attempt of the subject's own is over, which is what any
  // request naming it is told.
  if (ownPrunedAttempt(state, subject, attemptId)) throw Errors.MEETING_CONNECTION_CLOSED();
  const attempt = state.attempts[attemptId];
  const admission = attempt ? state.admissions[attempt.admissionId] : undefined;
  if (!attempt || !admission) throw Errors.NOT_FOUND("Participant");
  if (!ownsAdmission(subject, admission)) throw Errors.FORBIDDEN();
  return attempt;
}

export function ownApprovedAdmission(state: MeetingState, subject: Subject, attemptId: string): Admission {
  if (!isOpen(state)) throw Errors.MEETING_ENDED();
  const attempt = ownAttempt(state, subject, attemptId);
  const admission = state.admissions[attempt.admissionId];
  if (attempt.endedAt !== null || admission.status !== "approved") {
    throw Errors.MEETING_CONNECTION_CLOSED();
  }
  return admission;
}

/** The subject's admission that is in the meeting, approved and seated. */
function seatedAdmissionOf(state: MeetingState, subject: Subject): Admission | undefined {
  return Object.values(state.admissions).find(
    (admission) =>
      ownsAdmission(subject, admission) &&
      admission.status === "approved" &&
      holdsSeat(state, admission.id),
  );
}

/** Running a meeting is done from a seat in it, as a host or moderator. */
export function requireModerator(state: MeetingState, subject: Subject): { userId: string | null; host: boolean } {
  if (!isOpen(state)) throw Errors.NOT_FOUND("Meeting");
  const seated = seatedAdmissionOf(state, subject);
  if (!seated || !canModerate(state, seated)) throw Errors.FORBIDDEN();
  return { userId: seated.userId, host: roleOf(state, seated) === "host" };
}

/** One of the Space's owner and admins, as the Worker read them for this request. */
export function isAdmin(subject: Subject): subject is Extract<Subject, { kind: "user" }> {
  return subject.kind === "user" && subject.spaceRole === "admin";
}

/**
 * A host acts from their seat. With `fromOutside`, the Space's owner and
 * admins may also act without one: ending or renaming their Space's meeting
 * is Space authority, used from the Space's pages.
 */
export function requireHost(
  state: MeetingState,
  subject: Subject,
  options: { fromOutside?: boolean } = {},
): { userId: string } {
  if (!isOpen(state)) throw Errors.NOT_FOUND("Meeting");
  if (options.fromOutside && isAdmin(subject)) return { userId: subject.userId };
  const seated = seatedAdmissionOf(state, subject);
  if (!seated?.userId || !canManage(state, seated)) throw Errors.FORBIDDEN();
  return { userId: seated.userId };
}

// ─── Views ───────────────────────────────────────────────────────────────────

export function egressView(state: MeetingState, forModerator: boolean): EgressView {
  const egress = state.egress;
  const active = egress.status === "active";
  return {
    recordingActive: active && egress.mode === "recording",
    streamingActive: active && egress.mode === "streaming",
    egressId: forModerator ? egress.egressId : null,
    mode: egress.desired ?? egress.mode,
    status: egress.op ? "starting" : egress.status,
    revision: egress.revision,
    lastFailure: forModerator ? egress.lastFailure : null,
  };
}

export function view(state: MeetingState, admission: Admission, attempt: Attempt): ParticipantView {
  return {
    meetingId: state.meta.meetingId,
    meetingStartedAt: state.meta.startedAt,
    attemptId: attempt.id,
    identity: attempt.identity,
    admissionId: admission.id,
    displayName: admission.displayName,
    userId: admission.userId,
    role: roleOf(state, admission),
    canModerate: canModerate(state, admission),
    canManageMeeting: canManage(state, admission),
    joinPolicy: state.meta.joinPolicy,
    nodeId: attempt.nodeId,
    captionLanguage: attempt.captionLanguage,
    tokenExpiresAt: tokenExpiresAt(attempt),
    grant: grantFor(state, admission),
    room: roomMetadataFor(state),
    recordingEnabled: state.meta.recordingEnabled,
    egress: egressView(state, canModerate(state, admission)),
  };
}

// ─── Small helpers ───────────────────────────────────────────────────────────

export function attemptByIdentity(state: MeetingState, identity: string): Attempt | undefined {
  return Object.values(state.attempts).find((attempt) => attempt.identity === identity);
}

export function addStray(state: MeetingState, identity: string): void {
  if (!state.room.strays.includes(identity)) state.room.strays.push(identity);
}

/**
 * An egress the meeting tracks is never a stray: a start's late reply naming
 * the egress a room lookup already adopted for it describes the same egress.
 */
export function addStrayEgress(state: MeetingState, egressId: string): void {
  if (egressId === state.egress.egressId) return;
  if (!state.egress.strays.includes(egressId)) state.egress.strays.push(egressId);
}

export function setScreenShare(
  admission: Admission,
  next: Admission["screenShare"],
  now: number,
  ask: Admission["screenShareAsk"] = null,
): void {
  if (admission.screenShare === next) return;
  admission.screenShare = next;
  admission.screenShareRevision += 1;
  admission.screenShareAsk = ask;
  touch(admission, now);
}

/**
 * A time stamped on an admission. Its row holds every stamp at or after
 * `created_at` (`meeting_admissions_timestamps_check`), and `created_at` was
 * read from the clock of whichever machine created the admission; this commit
 * may run on one whose clock is behind it. A stamp under it would fail the
 * projection on every retry — the state is already kept, so the same values
 * replay — and wedge the meeting. Every admission time goes through here.
 */
export function admissionTime(admission: Admission, now: number): number {
  return Math.max(now, admission.createdAt);
}

export function touch(admission: Admission, now: number): void {
  admission.updatedAt = admissionTime(admission, now);
}

export function bumpRoom(state: MeetingState): void {
  state.room.version += 1;
}

export function bumpEgress(state: MeetingState): void {
  state.egress.revision += 1;
  bumpRoom(state);
}
