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
      if (input.placement && !isCurrentPlacement(state, input.placement)) return;
      observeEgress(state, input.egresses, input.complete ? input.requestedAt : null, now);
      return;
  }
}

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
    const current = attempt.sessionJoinedAt;
    const stale = current !== null && sessionJoinedAt !== null
      ? sessionJoinedAt < current
      : report.requestedAt !== null && attempt.sidKnownSince !== null && report.requestedAt < attempt.sidKnownSince;
    if (stale) return;
    attempt.appliedGrant = null;
    attempt.sid = sid;
    attempt.sessionJoinedAt = sessionJoinedAt;
    attempt.sidKnownSince = report.requestedAt ?? now;
  }
  attempt.absentSince = null;
  if (attempt.joinedAt !== null) return;
  const joinedAt = Math.max(at, attempt.issuedAt);
  attempt.joinedAt = joinedAt;

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

function issuedBefore(state: MeetingState, a: Attempt, b: Attempt): boolean {
  if (a.issuedAt !== b.issuedAt) return a.issuedAt < b.issuedAt;
  const order = Object.keys(state.attempts);
  return order.indexOf(a.id) < order.indexOf(b.id);
}

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
  let predatesDeparture = false;
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

export function endMeeting(state: MeetingState, reason: EndReason, now: number): void {
  const { meta } = state;
  meta.phase = "ended";
  meta.endedAt = now;
  meta.endReason = meta.firstJoinedAt === null ? "discarded" : reason;
  bumpRoom(state);
  const roles = liveRoles(state);
  for (const attempt of Object.values(state.attempts)) {
    endAttempt(state, attempt, "meeting_finalized", now, roles.get(attempt.id));
  }
  for (const admission of Object.values(state.admissions)) {
    if (admission.status === "pending") decide(state, admission, "expired", null, "meeting_ended", now);
  }
  stopEgressWhenEnded(state);
  if (state.surface.open) closeSurface(state, now);
}

export function place(state: MeetingState, nodeId: string, now: number): void {
  const { meta } = state;
  if (meta.nodeId === nodeId || !isOpen(state)) return;
  if (meta.nodeId !== null) {
    abandonNode(state, "media_node_moved", now);
    state.room.deleted = false;
  }
  meta.nodeId = nodeId;
  meta.placement += 1;
}

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

function newRoomInstance(state: MeetingState): void {
  state.room.appliedVersion = 0;
  state.room.instance += 1;
}

export function nodeUnreachable(state: MeetingState, now: number): boolean {
  const since = state.room.unreachableSince;
  return since !== null && now - since >= MEDIA_NODE_UNREACHABLE_GRACE_MS;
}
