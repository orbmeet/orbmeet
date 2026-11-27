import {
  ABSENT_GRACE_MS,
  ISSUE_GRACE_MS,
  MEDIA_NODE_UNREACHABLE_GRACE_MS,
  isCurrentPlacement,
  isOpen,
  type Attempt,
  type EndReason,
  type MeetingState,
} from "../model";
import type { Observation, ObservedParticipant } from "../protocol";
import { addStray, attemptByIdentity, bumpRoom } from "./access";
import { decide, endAttempt, liveRoles } from "./authority";
import { failEgress, observeEgress, stopEgressWhenEnded } from "./egress";
import { closeSurface } from "./surface";

export function observe(state: MeetingState, input: Observation, now: number): void {
  switch (input.kind) {
    case "participantJoined": {
      const attempt = attemptByIdentity(state, input.identity);
      if (!attempt || attempt.endedAt !== null) {
        addStray(state, input.identity);
        return;
      }
      markJoined(state, attempt, { sid: input.sid, joinedAt: input.joinedAt, requestedAt: null }, input.at, now);
      return;
    }
    case "participantLeft": {
      const attempt = attemptByIdentity(state, input.identity);
      if (!attempt || attempt.endedAt !== null) return;
      // LiveKit reports a full client reconnect as a departure followed by a
      // join. The departure only marks the attempt absent; the next presence
      // check decides.
      if (input.sid && attempt.sid && input.sid !== attempt.sid) return;
      attempt.absentSince ??= now;
      state.room.lastPresenceCheckAt = null;
      return;
    }
    case "roomStarted":
      newRoomInstance(state);
      state.room.deleted = false;
      return;
    case "roomFinished":
      newRoomInstance(state);
      state.room.lastPresenceCheckAt = null;
      for (const attempt of Object.values(state.attempts)) {
        if (attempt.endedAt === null && attempt.joinedAt !== null) attempt.absentSince ??= now;
      }
      return;
    case "egressObserved":
      // A listing from a placement the meeting has left describes another room.
      if (input.placement && !isCurrentPlacement(state, input.placement)) return;
      observeEgress(state, input.egresses, input.complete ? input.requestedAt : null, now);
      return;
  }
}

/**
 * A report that the attempt is in the room: the session `sid` LiveKit has for
 * it, when that session joined on LiveKit's clock if LiveKit said, and for a
 * listing, when it was requested on this coordinator's.
 *
 * `at` is when it joined, on the clock of whichever machine heard it. A join
 * is never recorded before the attempt's token was issued: the room may have
 * moved to a machine whose clock is behind the one that issued it, and D1
 * refuses a connection that joined before its token existed.
 */
function markJoined(
  state: MeetingState,
  attempt: Attempt,
  report: { sid: string | null; joinedAt: number | null; requestedAt: number | null },
  at: number,
  now: number,
): void {
  const { sid, joinedAt: sessionJoinedAt } = report;
  const admission = state.admissions[attempt.admissionId];
  if (!admission || admission.status !== "approved" || !isOpen(state)) {
    endAttempt(state, attempt, "admission_revoked", now);
    addStray(state, attempt.identity);
    return;
  }
  if (sid && sid !== attempt.sid) {
    // A report of a session that joined before the current one (a listing
    // taken before a reconnect, applied after it) is old news about it. Each
    // clock is compared only with itself: LiveKit's join times when it gave
    // both, otherwise when the listing was asked for against when this
    // coordinator first knew of the current session.
    const current = attempt.sessionJoinedAt;
    const stale = current !== null && sessionJoinedAt !== null
      ? sessionJoinedAt < current
      : report.requestedAt !== null && attempt.sidKnownSince !== null && report.requestedAt < attempt.sidKnownSince;
    if (stale) return;
    // A new session, first or after a full reconnect, was admitted on one of
    // the attempt's join tokens: which one, and so which grant it holds, is
    // not known here. Whatever was applied to an earlier session is gone.
    attempt.appliedGrant = null;
    attempt.sid = sid;
    attempt.sessionJoinedAt = sessionJoinedAt;
    attempt.sidKnownSince = report.requestedAt ?? now;
  }
  attempt.absentSince = null;
  if (attempt.joinedAt !== null) return;
  const joinedAt = Math.max(at, attempt.issuedAt);
  attempt.joinedAt = joinedAt;

  // The newest attempt to join is the participant: it ends every earlier one
  // of theirs. Issue order decides, not the order joins are heard in — a
  // webhook can be lost, and one listing can report several joins at once.
  for (const other of Object.values(state.attempts)) {
    if (
      other.id !== attempt.id &&
      other.admissionId === attempt.admissionId &&
      other.endedAt === null &&
      issuedBefore(state, other, attempt)
    ) {
      endAttempt(state, other, "superseded", now);
    }
  }

  if (state.meta.phase === "provisional") {
    state.meta.phase = "live";
    state.meta.firstJoinedAt = joinedAt;
  }
  state.room.emptySince = null;
}

/**
 * Whether `a` was issued before `b`. Attempts are recorded as they are issued,
 * so the record's order settles two issued within the same millisecond.
 */
function issuedBefore(state: MeetingState, a: Attempt, b: Attempt): boolean {
  if (a.issuedAt !== b.issuedAt) return a.issuedAt < b.issuedAt;
  const order = Object.keys(state.attempts);
  return order.indexOf(a.id) < order.indexOf(b.id);
}

/**
 * Compare the room, as a listing requested at `requestedAt` saw it, with the
 * attempts. The listing is the only evidence about a token that was handed
 * out: LiveKit does not guarantee its webhooks, so an attempt never reported
 * to have joined ends as unused only when a listing requested after its grace
 * does not find it.
 */
export function reconcilePresence(
  state: MeetingState,
  participants: ObservedParticipant[],
  roomExists: boolean,
  requestedAt: number,
  now: number,
): void {
  state.room.unreachableSince = null;
  if (!roomExists) newRoomInstance(state);
  const present = new Map(participants.filter((p) => p.standard).map((p) => [p.identity, p]));
  // A listing asked for before a departure was heard cannot speak to it: the
  // person may have left after it was taken. The attempt stays absent, and
  // the listing is not the fresh look the departure asked for.
  let predatesDeparture = false;
  // One listing can end several attempts at once.
  const roles = liveRoles(state);

  for (const attempt of Object.values(state.attempts)) {
    if (attempt.endedAt !== null) continue;
    const seen = present.get(attempt.identity);
    if (seen !== undefined) {
      if (attempt.absentSince !== null && requestedAt < attempt.absentSince) {
        predatesDeparture = true;
        continue;
      }
      markJoined(state, attempt, { sid: seen.sid, joinedAt: seen.joinedAt, requestedAt }, now, now);
      continue;
    }
    if (attempt.joinedAt === null) {
      // If it arrives later anyway, its join is refused and it is removed.
      if (requestedAt - attempt.issuedAt >= ISSUE_GRACE_MS) endAttempt(state, attempt, "unused", now, roles.get(attempt.id));
      continue;
    }
    attempt.absentSince ??= now;
    if (now - attempt.absentSince >= ABSENT_GRACE_MS) {
      endAttempt(state, attempt, "participant_left", now, roles.get(attempt.id));
      attempt.removed = true;
    }
  }

  for (const [identity] of present) {
    const attempt = attemptByIdentity(state, identity);
    if (!attempt || attempt.endedAt !== null) addStray(state, identity);
  }
  state.room.lastPresenceCheckAt = predatesDeparture ? null : requestedAt;
}

/**
 * Stop the meeting, whatever stops it. One nobody ever joined did not happen:
 * it is discarded rather than ended, so it leaves no history and gives back
 * the one-time link that started it.
 */
export function endMeeting(state: MeetingState, reason: EndReason, now: number): void {
  const { meta } = state;
  meta.phase = "ended";
  meta.endedAt = now;
  meta.endReason = meta.firstJoinedAt === null ? "discarded" : reason;
  // The room is told first (`ended` in its metadata), so the removals below
  // read as the end rather than as a kick to rejoin from.
  bumpRoom(state);
  // Everyone still in the room is removed now, not when the room is
  // deleted: deleting it waits for a running egress to stop.
  const roles = liveRoles(state);
  for (const attempt of Object.values(state.attempts)) {
    endAttempt(state, attempt, "meeting_finalized", now, roles.get(attempt.id));
  }
  for (const admission of Object.values(state.admissions)) {
    if (admission.status === "pending") decide(state, admission, "expired", null, "meeting_ended", now);
  }
  stopEgressWhenEnded(state);
  // The end is a boundary like a close: what the board showed is owed a pin.
  // A surface already closed was pinned when it closed; edits since are not
  // the meeting's.
  if (state.surface.open) closeSurface(state, now);
}

export function place(state: MeetingState, nodeId: string, now: number): void {
  const { meta } = state;
  if (meta.nodeId === nodeId || !isOpen(state)) return;
  if (meta.nodeId !== null) {
    // The meeting leaves a node its participants lost.
    abandonNode(state, "media_node_moved", now);
    state.room.deleted = false;
  }
  meta.nodeId = nodeId;
  meta.placement += 1;
}

/**
 * Let go of the meeting's media node: nothing on it can be reached. Its
 * attempts end there with nothing left to remove, and so does any egress.
 */
export function abandonNode(state: MeetingState, reason: string, now: number): void {
  const roles = liveRoles(state);
  for (const attempt of Object.values(state.attempts)) {
    if (attempt.nodeId !== state.meta.nodeId) continue;
    endAttempt(state, attempt, reason, now, roles.get(attempt.id));
    attempt.removed = true;
  }
  const egress = state.egress;
  if (egress.egressId || egress.op || egress.desired) {
    egress.egressId = null;
    egress.mode = null;
    egress.status = null;
    egress.startedAt = null;
    egress.knownSince = null;
    egress.op = null;
    failEgress(state, "The media server hosting this meeting became unreachable.");
  }
  state.room.strays = [];
  egress.strays = [];
  newRoomInstance(state);
  state.room.lastPresenceCheckAt = null;
  state.room.unreachableSince = null;
}

/**
 * The meeting's LiveKit room is gone, or a new one replaced it: it holds no
 * metadata, and a write still in flight for the old one says nothing about it.
 */
function newRoomInstance(state: MeetingState): void {
  state.room.appliedVersion = 0;
  state.room.instance += 1;
}

/** Whether every look at the room has failed for as long as it may. */
export function nodeUnreachable(state: MeetingState, now: number): boolean {
  const since = state.room.unreachableSince;
  return since !== null && now - since >= MEDIA_NODE_UNREACHABLE_GRACE_MS;
}
