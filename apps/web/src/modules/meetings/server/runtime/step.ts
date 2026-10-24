import { Errors } from "@/lib/app-errors";
import type { MeetingRole } from "@/modules/meetings/contract/constants";
import { getTerminalAdmissionError } from "@/modules/meetings/server/lifecycle/join-results";
import {
  ABSENT_GRACE_MS,
  ADMISSION_PENDING_TTL_MS,
  BARRED_MEMORY,
  EFFECT_RETRY_BASE_MS,
  EFFECT_RETRY_MAX_MS,
  EGRESS_START_TIMEOUT_MS,
  EMPTY_MEETING_GRACE_MS,
  ISSUE_GRACE_MS,
  MEDIA_NODE_UNREACHABLE_GRACE_MS,
  PRUNED_ATTEMPT_MEMORY,
  SETTLED_ATTEMPT_RETENTION_MS,
  WHITEBOARD_PIN_GIVE_UP_MS,
  canManage,
  canModerate,
  grantFor,
  grantHash,
  holdsSeat,
  initialState,
  isCurrentPlacement,
  isOpen,
  placementOf,
  roleOf,
  roleOnArrival,
  roomMetadataFor,
  seatAvailable,
  surfaceViewFor,
  whiteboardAuthorityHash,
  type Admission,
  type Attempt,
  type EgressMode,
  type EgressState,
  type EndReason,
  type MeetingState,
  type SurfaceFocus,
} from "./model";
import type {
  Command,
  EffectResult,
  EgressStartEffect,
  EgressView,
  Input,
  KeptOut,
  Observation,
  ObservedEgress,
  ObservedParticipant,
  Outcome,
  ParticipantView,
  Reply,
  Subject,
} from "./protocol";
import { wantedEffectKeys } from "./plan";

export interface Applied {
  state: MeetingState;
  /** The last kept input's reply. */
  reply?: Reply;
  once: EgressStartEffect[];
  /** What refused the input that stopped the run, if one did. */
  refusal?: unknown;
}

/**
 * Apply a request's inputs in order, the way the room commits them. Each input
 * steps its own copy, kept only when it returns, so a refused input keeps
 * nothing it did before refusing; the inputs before it are kept, and time
 * still moves on. `state` itself is never changed.
 */
export function applyInputs(state: MeetingState, inputs: readonly Input[], now: number): Applied {
  const applied: Applied = { state, once: [] };
  for (const input of inputs) {
    try {
      const stepped = step(structuredClone(applied.state), input, now);
      applied.state = stepped.state;
      applied.reply = stepped.outcome.reply;
      applied.once.push(...stepped.outcome.once);
    } catch (error) {
      applied.refusal = error;
      const ticked = step(structuredClone(applied.state), { kind: "tick" }, now);
      applied.state = ticked.state;
      applied.once.push(...ticked.outcome.once);
      break;
    }
  }
  return applied;
}

/**
 * Apply one input. Mutates `state` even when it then refuses, so callers go
 * through {@link applyInputs}, which steps a copy.
 *
 * Time moves first (`advance`), so every input sees expired waiters, lapsed
 * seats and a reached duration limit before it acts.
 */
export function step(state: MeetingState | null, input: Input, now: number): {
  state: MeetingState;
  outcome: Outcome;
} {
  if (input.kind === "init") {
    return { state: state ?? initialState(input.snapshot, now), outcome: { once: [] } };
  }
  if (!state) throw Errors.NOT_FOUND("Meeting");
  const outcome: Outcome = { once: [] };
  advance(state, now, outcome);
  dispatch(state, input, now, outcome);
  advance(state, now, outcome);
  pruneRetries(state, now);
  return { state, outcome };
}

function dispatch(
  state: MeetingState,
  input: Exclude<Input, { kind: "init" }>,
  now: number,
  outcome: Outcome,
): void {
  switch (input.kind) {
    case "tick":
      break;
    case "effectSucceeded":
      delete state.retries[input.key];
      dispatch(state, input.result, now, outcome);
      break;
    case "participantJoined":
    case "participantLeft":
    case "roomStarted":
    case "roomFinished":
    case "egressObserved":
      observe(state, input, now);
      break;
    case "placed":
    case "grantApplied":
    case "removed":
    case "participantsListed":
    case "authorityChecked":
    case "metadataApplied":
    case "egressStartResult":
    case "egressStopped":
    case "roomDeleted":
    case "finalized":
    case "postTasksDone":
    case "whiteboardPinned":
    case "whiteboardAuthorityApplied":
    case "whiteboardCaptureStarted":
    case "drained":
    case "effectFailed":
      applyResult(state, input, now);
      break;
    default:
      outcome.reply = command(state, input, now, outcome);
  }
}

/**
 * Keep retry backoff only for effects the state still calls for. An effect
 * whose subject went away (an attempt that left, an egress no longer wanted)
 * is never planned again, so nothing else would clear its entry.
 */
function pruneRetries(state: MeetingState, now: number): void {
  const wanted = wantedEffectKeys(state, now);
  for (const key of Object.keys(state.retries)) {
    if (!wanted.has(key)) delete state.retries[key];
  }
}

/** Effects that look at the meeting's room on its media node. */
const ROOM_LOOKS = new Set(["presence", "egress.list", "room.delete"]);

// ─── Time ────────────────────────────────────────────────────────────────────

function advance(state: MeetingState, now: number, outcome: Outcome): void {
  pruneSettled(state, now);
  if (!isOpen(state)) {
    stopEgressWhenEnded(state);
    // An ended meeting's room dies with its node; waiting for it would
    // keep the meeting from ever draining.
    if (state.meta.phase === "ended" && nodeUnreachable(state, now)) {
      abandonNode(state, "media_unreachable", now);
      state.room.deleted = true;
    }
    return;
  }
  const { meta } = state;

  // Nobody can be seen in a room nobody can reach. Their attempts end, so the
  // meeting empties and ends unless someone rejoins, which moves it.
  if (nodeUnreachable(state, now)) abandonNode(state, "media_unreachable", now);

  if (meta.maxDurationMs !== null && now - meta.startedAt >= meta.maxDurationMs) {
    endMeeting(state, "system", now);
    return;
  }

  for (const admission of Object.values(state.admissions)) {
    if (admission.status === "pending" && now - admission.createdAt >= ADMISSION_PENDING_TTL_MS) {
      decide(state, admission, "expired", null, "expired", now);
    }
  }

  const occupied =
    Object.values(state.attempts).some((attempt) => attempt.endedAt === null) ||
    Object.values(state.admissions).some((admission) => admission.status === "pending");
  if (occupied) {
    state.room.emptySince = null;
  } else if (state.room.emptySince === null) {
    state.room.emptySince = now;
  } else if (now - state.room.emptySince >= EMPTY_MEETING_GRACE_MS) {
    // Nobody is present, on the way in, or waiting.
    endMeeting(state, "natural", now);
    return;
  }

  planEgressStart(state, now, outcome);
}

/**
 * Forget what is over: attempts that ended and left the room, and approval
 * requests that expired (a pending admission never has attempts). Their rows
 * are final in D1, so keeping them would only grow the state for as long as
 * the meeting runs — with every request anyone ever made. A late webhook for a
 * forgotten identity is treated like any unknown one: removed from the room;
 * a guest naming a forgotten request asks again, as a signed-in user does.
 */
function pruneSettled(state: MeetingState, now: number): void {
  for (const [id, admission] of Object.entries(state.admissions)) {
    if (admission.status === "expired" && now - admission.updatedAt >= SETTLED_ATTEMPT_RETENTION_MS) {
      delete state.admissions[id];
    }
  }
  for (const [id, attempt] of Object.entries(state.attempts)) {
    if (attempt.endedAt !== null && attempt.removed && now - attempt.endedAt >= SETTLED_ATTEMPT_RETENTION_MS) {
      delete state.attempts[id];
      state.prunedAttempts[id] = { admissionId: attempt.admissionId, endReason: attempt.endReason };
    }
  }
  const pruned = Object.keys(state.prunedAttempts);
  for (const id of pruned.slice(0, Math.max(0, pruned.length - PRUNED_ATTEMPT_MEMORY))) {
    delete state.prunedAttempts[id];
  }
}

// ─── Commands ────────────────────────────────────────────────────────────────

function command(
  state: MeetingState,
  input: Command,
  now: number,
  outcome: Outcome,
): Outcome["reply"] {
  switch (input.kind) {
    case "join":
      return join(state, input, now);
    case "release": {
      // Forgotten means long over: nothing left to release.
      if (ownPrunedAttempt(state, input.subject, input.attemptId)) return { kind: "ok" };
      const attempt = ownAttempt(state, input.subject, input.attemptId);
      if (attempt.endedAt === null && attempt.joinedAt === null) {
        endAttempt(attempt, "released", now);
      }
      return { kind: "ok" };
    }
    case "leave": {
      if (ownPrunedAttempt(state, input.subject, input.attemptId)) return { kind: "left", found: false };
      const attempt = ownAttempt(state, input.subject, input.attemptId);
      endAttempt(attempt, "voluntary", now);
      // Found: this leave, or the same one repeated, ended it. An attempt
      // ended otherwise (taken over by another tab) was not this leave's.
      return { kind: "left", found: attempt.endReason === "voluntary" };
    }
    case "authorize": {
      requireModerator(state, input.subject);
      return { kind: "ok" };
    }
    case "listPending": {
      requireModerator(state, input.subject);
      return {
        kind: "pending",
        joinPolicy: state.meta.joinPolicy,
        pending: Object.values(state.admissions)
          .filter((admission) => admission.status === "pending")
          .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
          .map((admission) => ({
            id: admission.id,
            displayName: admission.displayName,
            userId: admission.userId,
            createdAt: admission.createdAt,
          })),
      };
    }
    case "decideAdmission": {
      const actor = requireModerator(state, input.subject);
      const target = state.admissions[input.admissionId];
      // Decided this way already, by this request or another moderator.
      if (target?.status === (input.approve ? "approved" : "denied")) return { kind: "ok" };
      if (!target || target.status !== "pending") {
        throw Errors.CONFLICT("Participant is no longer awaiting approval");
      }
      // `closed` means no new entrants. Only a host, who set the policy,
      // may deliberately admit through it; anyone may clear the queue.
      if (input.approve && state.meta.joinPolicy === "closed" && !actor.host) {
        throw Errors.MEETING_CLOSED();
      }
      decide(state, target, input.approve ? "approved" : "denied", actor.userId, null, now);
      return { kind: "ok" };
    }
    case "setJoinPolicy": {
      const actor = requireHost(state, input.subject);
      if (state.meta.joinPolicy === input.joinPolicy) return { kind: "joinPolicy", joinPolicy: input.joinPolicy };
      state.meta.joinPolicy = input.joinPolicy;
      bumpRoom(state);
      if (input.joinPolicy === "open") {
        for (const admission of Object.values(state.admissions)) {
          if (admission.status === "pending") decide(state, admission, "approved", actor.userId, null, now);
        }
      }
      return { kind: "joinPolicy", joinPolicy: input.joinPolicy };
    }
    case "renameMeeting": {
      requireHost(state, input.subject, { fromOutside: true });
      const { meta } = state;
      // The same rename again is answered, not refused.
      if (meta.title !== input.title) {
        if (meta.title !== input.expectedTitle) {
          throw Errors.CONFLICT("This Meeting title changed elsewhere. Review it and try again.");
        }
        meta.title = input.title;
      }
      return { kind: "title", title: meta.title };
    }
    case "setModerator": {
      requireHost(state, input.subject);
      const attempt = Object.values(state.attempts).find(
        (candidate) => candidate.identity === input.identity && candidate.endedAt === null,
      );
      const target = attempt ? state.admissions[attempt.admissionId] : undefined;
      if (!target || target.status !== "approved") throw Errors.NOT_FOUND("Participant");
      if (roleOf(state, target) === "host") {
        throw Errors.VALIDATION("A host is already above a moderator.");
      }
      if (target.moderator !== input.moderator) {
        target.moderator = input.moderator;
        touch(target, now);
      }
      return { kind: "role", role: roleOf(state, target) };
    }
    case "removeParticipant": {
      const actor = requireModerator(state, input.subject);
      const target = state.admissions[input.admissionId];
      if (!target || (target.status !== "approved" && target.status !== "revoked")) {
        throw Errors.NOT_FOUND("Participant");
      }
      if (ownsAdmission(input.subject, target)) throw Errors.VALIDATION("Leave the meeting to remove yourself.");
      // Keeping someone out reaches everything a bar covers, so the rule
      // reads the strongest role among those, not the one admission named:
      // an admission already revoked must not bar a user seated as moderator.
      const role = strongestRole(state, keptOutBy(state, target));
      if (role === "host") throw Errors.FORBIDDEN("A meeting host can't be removed.");
      if (role === "moderator" && !actor.host) throw Errors.FORBIDDEN("Only a host can remove a moderator.");
      if (target.status === "approved") {
        decide(state, target, "revoked", actor.userId, "removed_by_moderator", now);
      }
      // Out already, by this request, another moderator or their Space: what
      // was asked is that they stay out.
      return { kind: "removed", keptOut: bar(state, target, actor.userId, now) };
    }
    case "raiseHand": {
      const admission = ownApprovedAdmission(state, input.subject, input.attemptId);
      if (roleOf(state, admission) !== "attendee") throw Errors.VALIDATION("Moderators do not raise hands.");
      if (!admission.hand) {
        admission.hand = { raiseId: input.raiseId, raisedAt: now };
        touch(admission, now);
      }
      return { kind: "ok" };
    }
    case "lowerHand": {
      const admission = ownApprovedAdmission(state, input.subject, input.attemptId);
      if (admission.hand) {
        admission.hand = null;
        touch(admission, now);
      }
      return { kind: "ok" };
    }
    case "resolveHand": {
      requireModerator(state, input.subject);
      const target = state.admissions[input.admissionId];
      if (target?.hand) {
        target.hand = null;
        touch(target, now);
      }
      return { kind: "ok" };
    }
    case "requestScreenShare": {
      const admission = ownApprovedAdmission(state, input.subject, input.attemptId);
      if (roleOf(state, admission) === "attendee" && admission.screenShare === "none") {
        admission.screenShare = "requested";
        touch(admission, now);
      }
      return { kind: "ok" };
    }
    case "decideScreenShare": {
      requireModerator(state, input.subject);
      const target = state.admissions[input.admissionId];
      if (!target || target.status !== "approved") throw Errors.NOT_FOUND("Participant");
      if (roleOf(state, target) !== "attendee") {
        throw Errors.VALIDATION("Hosts and moderators can always share their screen.");
      }
      const next = input.allow ? "granted" : "none";
      if (target.screenShare !== next) {
        target.screenShare = next;
        touch(target, now);
      }
      return { kind: "ok" };
    }
    case "grantBoardEdit": {
      requireModerator(state, input.subject);
      const target = input.principal.type === "user"
        ? liveAdmissionOf(state, input.principal.id)
        : state.admissions[input.principal.id];
      if (!target || target.status !== "approved" || (input.principal.type === "guest_admission" && target.userId !== null)) {
        throw Errors.VALIDATION("The grant target is not an admitted participant of this Meeting");
      }
      // Hosts and moderators edit already; there is nothing to grant them.
      if (roleOf(state, target) === "attendee" && !target.boardEdit) {
        target.boardEdit = true;
        touch(target, now);
      }
      return { kind: "ok" };
    }
    case "requestBoard": {
      const admission = ownApprovedAdmission(state, input.subject, input.attemptId);
      // A moderator opens it; an open board has nothing to ask for.
      const requested = input.requested && roleOf(state, admission) === "attendee" && !state.surface.open;
      if (admission.boardRequested !== requested) {
        admission.boardRequested = requested;
        touch(admission, now);
      }
      return { kind: "ok" };
    }
    case "declineBoardRequest": {
      requireModerator(state, input.subject);
      const target = state.admissions[input.admissionId];
      if (target?.boardRequested) {
        target.boardRequested = false;
        touch(target, now);
      }
      return { kind: "ok" };
    }
    case "setTranscription": {
      requireModerator(state, input.subject);
      if (state.meta.transcription !== input.on) {
        state.meta.transcription = input.on;
        if (!input.on) answerAsks(state, "transcriptionStopRequested", now);
        bumpRoom(state);
      }
      return { kind: "transcription", on: state.meta.transcription };
    }
    case "requestTranscriptionStop": {
      const admission = ownApprovedAdmission(state, input.subject, input.attemptId);
      // A moderator turns it off themselves; one that is off has nothing to ask for.
      const requested = input.requested && roleOf(state, admission) === "attendee" && state.meta.transcription;
      if (admission.transcriptionStopRequested !== requested) {
        admission.transcriptionStopRequested = requested;
        touch(admission, now);
      }
      return { kind: "ok" };
    }
    case "declineTranscriptionStop": {
      requireModerator(state, input.subject);
      const target = state.admissions[input.admissionId];
      if (target?.transcriptionStopRequested) {
        target.transcriptionStopRequested = false;
        touch(target, now);
      }
      return { kind: "ok" };
    }
    case "stopScreenShare": {
      const admission = ownApprovedAdmission(state, input.subject, input.attemptId);
      if (admission.screenShare !== "none") {
        admission.screenShare = "none";
        touch(admission, now);
      }
      return { kind: "ok" };
    }
    case "setCountdown": {
      requireModerator(state, input.subject);
      if (state.countdown.endsAt !== input.endsAt) {
        state.countdown = { endsAt: input.endsAt, version: state.countdown.version + 1 };
        bumpRoom(state);
      }
      return { kind: "ok" };
    }
    case "setEgress": {
      requireHost(state, input.subject);
      setEgress(state, input.mode, input.on, input.target, now, outcome);
      return { kind: "egress", egress: egressView(state, true) };
    }
    case "setSurface": {
      requireModerator(state, input.subject);
      setSurface(state, input.open, input.fallback, now);
      return { kind: "surface", surface: surfaceViewFor(state) };
    }
    case "present": {
      requireModerator(state, input.subject);
      present(state, input.focus, now);
      return { kind: "surface", surface: surfaceViewFor(state) };
    }
    case "end": {
      // Ended already, by this request's retry or anyone: what was asked is done.
      if (!isOpen(state)) return { kind: "ok" };
      if (input.subject.kind !== "system") requireHost(state, input.subject, { fromOutside: true });
      endMeeting(state, input.reason, now);
      return { kind: "ok" };
    }
    case "authority": {
      applyAuthority(state, input.userId, input.spaceRole, input.reason, Math.min(input.readAt, now), now);
      return { kind: "ok" };
    }
    case "revoke": {
      revokeUser(state, input.userId, input.reason, now);
      return { kind: "ok" };
    }
  }
}

function join(
  state: MeetingState,
  input: Extract<Command, { kind: "join" }>,
  now: number,
): Outcome["reply"] {
  if (!isOpen(state)) throw Errors.MEETING_ENDED();
  const { meta } = state;
  const subject = input.subject;
  if (subject.kind === "system") throw Errors.FORBIDDEN();
  if (subject.kind === "guest" && !meta.allowGuests) throw Errors.UNAUTHORIZED();
  if (subject.kind === "user" && meta.spaceKind === "shared" && subject.spaceRole === "visitor") {
    throw Errors.FORBIDDEN();
  }
  const admin = isAdmin(subject);
  // Whoever will host walks in as a host: past approval and a closed meeting.
  const hosts = (candidate: Admission) => admin || roleOnArrival(state, candidate) === "host";

  // A guest's first join, repeated, carries the secret it brought the first
  // time (the Worker derives it from the client's key for that first join):
  // it is answered with the admission that secret created, and the cookie is
  // set again.
  const repeatedGuest = subject.kind === "guest" && !input.admissionId && input.newGuestSecretHash
    ? Object.values(state.admissions).find(
        (candidate) => candidate.userId === null && candidate.guestSecretHash === input.newGuestSecretHash,
      )
    : undefined;
  // A signed-in user is one participant however many tabs or devices they
  // join from: without a named admission they continue the one they have, so
  // they neither take a second seat nor wait for approval again.
  let admission = repeatedGuest ?? (input.admissionId
    ? state.admissions[input.admissionId]
    : subject.kind === "user"
      ? liveAdmissionOf(state, subject.userId)
      : undefined);
  let newGuestAdmission = repeatedGuest !== undefined;
  if (admission && !repeatedGuest && !ownsAdmission(subject, admission)) throw Errors.FORBIDDEN();
  // Whatever admission a join names, or none: a bar is on the person, and
  // only the Space's owner and admins are above it.
  if (!admin) refuseBarred(state, subject, admission, input.guestNetworkKey);
  if (!admission) {
    if (subject.kind === "guest" && !input.newGuestSecretHash) throw Errors.UNAUTHORIZED();
    const created: Admission = {
      id: input.newAdmissionId,
      userId: subject.kind === "user" ? subject.userId : null,
      guestSecretHash: subject.kind === "guest" ? input.newGuestSecretHash : null,
      networkKey: subject.kind === "guest" ? input.guestNetworkKey : null,
      displayName: input.displayName,
      status: "pending",
      decidedByUserId: null,
      decidedAt: null,
      decisionReason: null,
      createdAt: now,
      updatedAt: now,
      moderator: false,
      spaceRole: subject.kind === "user" ? subject.spaceRole : "visitor",
      spaceRoleAt: now,
      screenShare: "none",
      boardEdit: false,
      boardRequested: false,
      transcriptionStopRequested: false,
      hand: null,
      whiteboardAuthority: "",
    };
    const hosting = hosts(created);
    if (meta.joinPolicy === "closed" && !hosting) throw Errors.MEETING_CLOSED();
    const approved = hosting || meta.joinPolicy === "open";
    if (approved) {
      created.status = "approved";
      created.decidedByUserId = subject.kind === "user" ? subject.userId : null;
      created.decidedAt = now;
    }
    admission = created;
    // A whiteboard token minted from here on reads this authority from D1.
    admission.whiteboardAuthority = whiteboardAuthorityHash(state, admission);
    state.admissions[admission.id] = admission;
    newGuestAdmission = subject.kind === "guest";
    if (!approved) {
      state.admissionsVersion += 1;
      bumpRoom(state);
    }
  }

  if (admission.status === "pending") {
    if (meta.joinPolicy === "open" || hosts(admission)) {
      decide(state, admission, "approved", null, null, now);
    } else if (meta.joinPolicy === "closed") {
      throw Errors.MEETING_CLOSED();
    } else {
      return { kind: "waiting", admissionId: admission.id, newGuestAdmission };
    }
  }
  const terminal = getTerminalAdmissionError(admission.status);
  if (terminal) throw terminal;

  const replaced = input.replacesAttemptId
    ? state.attempts[input.replacesAttemptId] ?? state.prunedAttempts[input.replacesAttemptId]
    : undefined;
  if (replaced?.admissionId === admission.id && replaced.endReason === "superseded") {
    throw Errors.MEETING_OPEN_ELSEWHERE();
  }

  const existing = Object.values(state.attempts).find(
    (attempt) =>
      attempt.admissionId === admission.id && attempt.clientAttemptId === input.clientAttemptId,
  );
  if (existing) {
    // The same request, repeated: hand back the attempt it already created.
    if (existing.endedAt !== null) throw Errors.MEETING_CONNECTION_CLOSED();
    return { kind: "admitted", participant: view(state, admission, existing), newGuestAdmission };
  }

  if (!holdsSeat(state, admission.id) && !seatAvailable(state, admission)) {
    throw Errors.PLAN_LIMIT_REACHED("Meeting is full");
  }
  if (!meta.nodeId) throw Errors.MEDIA_UNAVAILABLE();

  const grant = grantFor(state, admission);
  const attempt: Attempt = {
    id: input.newAttemptId,
    identity: admission.userId ? `${admission.userId}_${input.newAttemptId}` : `guest_${input.newAttemptId}`,
    admissionId: admission.id,
    clientAttemptId: input.clientAttemptId,
    nodeId: meta.nodeId,
    issuedAt: now,
    joinedAt: null,
    endedAt: null,
    endReason: null,
    sid: null,
    sessionJoinedAt: null,
    sidKnownSince: null,
    absentSince: null,
    captionLanguage: input.captionLanguage,
    // The token carries this grant, so LiveKit starts out holding it.
    appliedGrant: grantHash(grant),
    tokenGrant: grantHash(grant),
    removed: false,
  };
  state.attempts[attempt.id] = attempt;
  state.room.emptySince = null;
  return { kind: "admitted", participant: view(state, admission, attempt), newGuestAdmission };
}

function setEgress(
  state: MeetingState,
  mode: EgressMode,
  on: boolean,
  target: string | null,
  now: number,
  outcome: Outcome,
): void {
  if (!isOpen(state)) throw Errors.MEETING_ENDED();
  const egress = state.egress;
  const label = mode === "recording" ? "Recording" : "Stream";
  if (on) {
    if (mode === "recording" && !state.meta.recordingEnabled) throw Errors.FORBIDDEN();
    if (egress.desired === mode) {
      // The same request again. A different destination is not: the stream
      // already wanted keeps its own until it is stopped.
      if (egress.target === (mode === "streaming" ? target : null)) return;
      throw Errors.VALIDATION("Stop the current stream before changing its destination.");
    }
    const other = egress.desired ?? egress.mode;
    if (other && other !== mode) {
      throw Errors.VALIDATION(
        mode === "recording"
          ? "Cannot record while streaming is active"
          : "Cannot stream while recording is active",
      );
    }
    if (egress.egressId) throw Errors.VALIDATION(`${label} is still stopping, please try again`);
    if (mode === "streaming" && !target) throw Errors.VALIDATION("Platform and stream key are required");
    egress.desired = mode;
    egress.target = mode === "streaming" ? target : null;
    egress.lastFailure = null;
    planEgressStart(state, now, outcome);
    return;
  }
  // Off already, whether asked before or never on.
  if (egress.desired !== mode && egress.mode !== mode) return;
  egress.desired = null;
  egress.target = null;
}

// ─── Observations ────────────────────────────────────────────────────────────

function observe(state: MeetingState, input: Observation, now: number): void {
  switch (input.kind) {
    case "participantJoined": {
      const attempt = attemptByIdentity(state, input.identity);
      if (!attempt || attempt.endedAt !== null) {
        addStray(state, input.identity);
        return;
      }
      markJoined(state, attempt, { sid: input.sid, joinedAt: input.joinedAt, requestedAt: null }, Math.max(input.at, attempt.issuedAt), now);
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
      observeEgress(state, input.egresses, input.complete, now);
      return;
  }
}

/**
 * A report that the attempt is in the room: the session `sid` LiveKit has for
 * it, when that session joined on LiveKit's clock if LiveKit said, and for a
 * listing, when it was requested on this coordinator's.
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
    endAttempt(attempt, "admission_revoked", now);
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
    // A new session is a full reconnect: LiveKit admitted it on the join
    // token's grant, and whatever was applied to the previous session is gone.
    if (attempt.sid !== null) attempt.appliedGrant = attempt.tokenGrant;
    attempt.sid = sid;
    attempt.sessionJoinedAt = sessionJoinedAt;
    attempt.sidKnownSince = report.requestedAt ?? now;
  }
  attempt.absentSince = null;
  if (attempt.joinedAt !== null) return;
  attempt.joinedAt = at;

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
      endAttempt(other, "superseded", now);
    }
  }

  if (state.meta.phase === "provisional") {
    state.meta.phase = "live";
    state.meta.firstJoinedAt = at;
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

function observeEgress(
  state: MeetingState,
  observed: ObservedEgress[],
  complete: boolean,
  now: number,
): void {
  const egress = state.egress;
  egress.lastPolledAt = now;
  if (complete) state.room.unreachableSince = null;

  // A start whose result never arrived: adopt what it created, or give it up.
  if (egress.op && !egress.egressId && complete) {
    // One already being stopped is not it.
    const orphan = observed.find(
      (info) => (info.status === "starting" || info.status === "active") && !egress.strays.includes(info.egressId),
    );
    // One that no longer matches what is wanted is left untracked, and so
    // stopped below.
    if (orphan && startStillWanted(egress, egress.op)) {
      egress.egressId = orphan.egressId;
      egress.mode = egress.desired;
      egress.status = "starting";
      egress.startedAt = egress.op.startedAt;
    } else if ((state.retries["egress.start"]?.failures ?? 0) >= 3) {
      failEgress(state, "LiveKit egress could not be started.");
    }
    egress.op = null;
  }

  // While a start is unanswered, the egress it created may already be
  // reported (LiveKit's `egress_started` webhook can beat the start's own
  // reply). Only a complete listing may decide an untracked egress is left
  // over; the orphan adoption above has already cleared the op when it did.
  const startUnanswered = egress.op !== null && !egress.egressId;
  for (const info of observed) {
    if (info.egressId === egress.egressId) continue;
    if (startUnanswered) continue;
    // Every egress in the room is this coordinator's: one it no longer tracks
    // is left over from a lost result or an earlier failure.
    if (info.status === "starting" || info.status === "active") addStrayEgress(state, info.egressId);
  }

  const current = egress.egressId
    ? observed.find((info) => info.egressId === egress.egressId)
    : undefined;
  if (!egress.egressId) return;
  if (!current) {
    if (complete) settleEgress(state, "The recording service lost track of this egress.");
    return;
  }

  switch (current.status) {
    case "starting":
    case "active": {
      const ready =
        current.status === "active" && (egress.mode !== "streaming" || current.streamActive);
      const failure = current.streamFailure;
      if (failure) {
        failEgress(state, failure);
      } else if (ready && egress.status === "starting") {
        egress.status = "active";
        egress.transition = "started";
        bumpEgress(state);
      } else if (
        egress.status === "starting" &&
        egress.startedAt !== null &&
        now - egress.startedAt > EGRESS_START_TIMEOUT_MS
      ) {
        failEgress(state, "LiveKit egress did not become active in time.");
      }
      return;
    }
    case "ending":
      egress.status = "stopping";
      return;
    case "complete":
    case "failed":
      settleEgress(state, current.error);
      return;
  }
}

/**
 * The tracked egress is over; say whether that was asked for. One already
 * reported failed (`lastFailure`, cleared by every start) was announced when
 * the failure was decided: the room only stops showing it.
 */
function settleEgress(state: MeetingState, error: string | null): void {
  const egress = state.egress;
  const announced = egress.lastFailure !== null;
  const expected = egress.desired === null;
  egress.egressId = null;
  egress.mode = null;
  egress.status = null;
  egress.startedAt = null;
  if (announced) {
    bumpRoom(state);
    return;
  }
  egress.transition = expected ? "stopped" : "failed";
  if (!expected) {
    egress.desired = null;
    egress.target = null;
    egress.lastFailure = error ?? "The egress ended unexpectedly.";
  }
  bumpEgress(state);
}

/** Whether what a start asked for is still what is wanted. */
function startStillWanted(egress: EgressState, op: NonNullable<EgressState["op"]>): boolean {
  return egress.desired === op.mode && egress.target === op.target;
}

function failEgress(state: MeetingState, message: string): void {
  const egress = state.egress;
  egress.desired = null;
  egress.target = null;
  egress.lastFailure = message;
  egress.transition = "failed";
  bumpEgress(state);
}

// ─── Effect results ──────────────────────────────────────────────────────────

function applyResult(state: MeetingState, input: EffectResult, now: number): void {
  // What an effect saw or did on a placement the meeting has since left is
  // about a room it no longer uses.
  if ("placement" in input && input.placement && !isCurrentPlacement(state, input.placement)) {
    if (input.kind === "effectFailed") recordFailure(state, input.key, now);
    return;
  }
  switch (input.kind) {
    case "placed":
      // A concurrent join may have placed or moved the meeting meanwhile.
      if (state.meta.nodeId === input.from) place(state, input.nodeId, now);
      return;
    case "grantApplied": {
      // Applied to the session it was planned for; a reconnect since then
      // started from the token's grant instead.
      const attempt = state.attempts[input.attemptId];
      if (attempt && attempt.sid === input.sid) attempt.appliedGrant = input.hash;
      return;
    }
    case "removed":
      for (const attempt of Object.values(state.attempts)) {
        if (attempt.identity === input.identity) attempt.removed = true;
      }
      state.room.strays = state.room.strays.filter((identity) => identity !== input.identity);
      return;
    case "participantsListed":
      reconcilePresence(state, input.participants, input.roomExists, input.requestedAt, now);
      return;
    case "authorityChecked":
      state.room.lastAuthorityCheckAt = now;
      for (const { userId, spaceRole } of input.roles) {
        applyAuthority(state, userId, spaceRole, "space_membership_removed", input.requestedAt, now);
      }
      return;
    case "metadataApplied":
      // Written to a room that has since gone: the current one holds none of it.
      if (input.room !== state.room.instance) return;
      state.room.appliedVersion = Math.max(state.room.appliedVersion, input.version);
      return;
    case "egressStartResult": {
      const egress = state.egress;
      if (egress.op?.id !== input.opId) {
        if (input.egressId) addStrayEgress(state, input.egressId);
        return;
      }
      const op = egress.op;
      egress.op = null;
      // Asked for before the host changed their mind: a refusal of it says
      // nothing about what is wanted now, and what it started is not that.
      const wanted = startStillWanted(egress, op);
      if (!input.egressId) {
        if (wanted) failEgress(state, input.error ?? "LiveKit egress did not start.");
        return;
      }
      if (!wanted) {
        addStrayEgress(state, input.egressId);
        return;
      }
      const startedAt = op.startedAt;
      egress.egressId = input.egressId;
      egress.mode = egress.desired;
      egress.status = "starting";
      egress.startedAt = startedAt;
      return;
    }
    case "egressStopped":
      state.egress.strays = state.egress.strays.filter((egressId) => egressId !== input.egressId);
      if (state.egress.egressId === input.egressId) {
        if (input.missing) settleEgress(state, null);
        else state.egress.status = "stopping";
      }
      return;
    case "roomDeleted":
      // Nobody is left in a deleted room.
      for (const attempt of Object.values(state.attempts)) attempt.removed = true;
      state.room.strays = [];
      state.room.deleted = true;
      state.room.unreachableSince = null;
      return;
    case "finalized":
      state.finalized = true;
      return;
    case "postTasksDone":
      state.postMeetingDone = true;
      return;
    case "whiteboardPinned": {
      // A newer boundary of the same board replaced this pin meanwhile; that
      // one still has to land.
      if (state.surface.pins[input.usageId]?.commandId === input.commandId) {
        delete state.surface.pins[input.usageId];
      }
      return;
    }
    case "whiteboardAuthorityApplied": {
      const admission = state.admissions[input.admissionId];
      if (admission) admission.whiteboardAuthority = input.hash;
      return;
    }
    case "whiteboardCaptureStarted":
      state.surface.captureStarted = true;
      return;
    case "drained":
      state.meta.phase = "drained";
      return;
    case "effectFailed": {
      recordFailure(state, input.key, now);
      giveUpStalePins(state, now);
      if (ROOM_LOOKS.has(input.key)) state.room.unreachableSince ??= now;
      // A start that failed without an answer may still have created an
      // egress: its op stays, and the room lookup adopts or clears it.
      return;
    }
  }
}

/** Back the effect off: base delay, doubled per failure, capped. */
function recordFailure(state: MeetingState, key: string, now: number): void {
  const failures = (state.retries[key]?.failures ?? 0) + 1;
  state.retries[key] = {
    failures,
    retryAt: now + Math.min(EFFECT_RETRY_BASE_MS * 2 ** (failures - 1), EFFECT_RETRY_MAX_MS),
  };
}

/**
 * Compare the room, as a listing requested at `requestedAt` saw it, with the
 * attempts. The listing is the only evidence about a token that was handed
 * out: LiveKit does not guarantee its webhooks, so an attempt never reported
 * to have joined ends as unused only when a listing requested after its grace
 * does not find it.
 */
function reconcilePresence(
  state: MeetingState,
  participants: ObservedParticipant[],
  roomExists: boolean,
  requestedAt: number,
  now: number,
): void {
  state.room.lastPresenceCheckAt = requestedAt;
  state.room.unreachableSince = null;
  if (!roomExists) newRoomInstance(state);
  const present = new Map(participants.filter((p) => p.standard).map((p) => [p.identity, p]));

  for (const attempt of Object.values(state.attempts)) {
    if (attempt.endedAt !== null) continue;
    const seen = present.get(attempt.identity);
    if (seen !== undefined) {
      markJoined(state, attempt, { sid: seen.sid, joinedAt: seen.joinedAt, requestedAt }, now, now);
      continue;
    }
    if (attempt.joinedAt === null) {
      // If it arrives later anyway, its join is refused and it is removed.
      if (requestedAt - attempt.issuedAt >= ISSUE_GRACE_MS) endAttempt(attempt, "unused", now);
      continue;
    }
    attempt.absentSince ??= now;
    if (now - attempt.absentSince >= ABSENT_GRACE_MS) {
      endAttempt(attempt, "participant_left", now);
      attempt.removed = true;
    }
  }

  for (const [identity] of present) {
    const attempt = attemptByIdentity(state, identity);
    if (!attempt || attempt.endedAt !== null) addStray(state, identity);
  }
}

// ─── Transitions ─────────────────────────────────────────────────────────────

function decide(
  state: MeetingState,
  admission: Admission,
  status: "approved" | "denied" | "revoked" | "expired",
  decidedByUserId: string | null,
  reason: string | null,
  now: number,
): void {
  const wasPending = admission.status === "pending";
  admission.status = status;
  admission.decidedByUserId = decidedByUserId;
  admission.decidedAt = now;
  admission.decisionReason = reason;
  if (status !== "approved") {
    admission.moderator = false;
    admission.screenShare = "none";
    admission.boardEdit = false;
    admission.boardRequested = false;
    admission.transcriptionStopRequested = false;
    admission.hand = null;
    for (const attempt of Object.values(state.attempts)) {
      if (attempt.admissionId === admission.id && attempt.endedAt === null) {
        endAttempt(attempt, reason ?? status, now);
      }
    }
  }
  touch(admission, now);
  if (wasPending) {
    state.admissionsVersion += 1;
    bumpRoom(state);
  }
}

function endAttempt(attempt: Attempt, reason: string, now: number): void {
  if (attempt.endedAt !== null) return;
  attempt.endedAt = Math.max(now, attempt.joinedAt ?? attempt.issuedAt);
  attempt.endReason = reason;
  // Only an attempt that reached the room has anything to remove from it.
  attempt.removed = attempt.joinedAt === null;
}

/**
 * Stop the meeting, whatever stops it. One nobody ever joined did not happen:
 * it is discarded rather than ended, so it leaves no history and gives back
 * the one-time link that started it.
 */
function endMeeting(state: MeetingState, reason: EndReason, now: number): void {
  const { meta } = state;
  meta.phase = "ended";
  meta.endedAt = now;
  meta.endReason = meta.firstJoinedAt === null ? "discarded" : reason;
  // The room is told first (`ended` in its metadata), so the removals below
  // read as the end rather than as a kick to rejoin from.
  bumpRoom(state);
  // Everyone still in the room is removed now, not when the room is
  // deleted: deleting it waits for a running egress to stop.
  for (const attempt of Object.values(state.attempts)) endAttempt(attempt, "meeting_finalized", now);
  for (const admission of Object.values(state.admissions)) {
    if (admission.status === "pending") decide(state, admission, "expired", null, "meeting_ended", now);
  }
  stopEgressWhenEnded(state);
  // The end is a boundary like a close: what the board showed is owed a pin.
  // A surface already closed was pinned when it closed; edits since are not
  // the meeting's.
  if (state.surface.open) closeSurface(state, now);
}

// ─── Whiteboard surface ──────────────────────────────────────────────────────

function setSurface(state: MeetingState, open: boolean, fallback: SurfaceFocus | null, now: number): void {
  if (!isOpen(state)) throw Errors.MEETING_ENDED();
  const { surface } = state;
  if (!open) {
    if (surface.open) closeSurface(state, now);
    return;
  }
  if (surface.open) return;
  const focus = surface.focus ?? fallback;
  if (!focus) throw Errors.VALIDATION("There is no whiteboard to show yet.");
  surface.focus = focus;
  surface.open = true;
  surface.revision += 1;
  surface.openRevision = surface.revision;
  answerAsks(state, "boardRequested", now);
  bumpRoom(state);
}

function present(state: MeetingState, focus: SurfaceFocus, now: number): void {
  if (!isOpen(state)) throw Errors.MEETING_ENDED();
  const { surface } = state;
  if (surface.open && surface.focus?.usageId === focus.usageId) return;
  // Leaving a shared board is its boundary. A closed one was pinned when it
  // closed.
  if (surface.open && surface.focus) owePin(state, surface.focus, now);
  const wasOpen = surface.open;
  surface.focus = focus;
  surface.open = true;
  surface.revision += 1;
  // Switching boards while open is not a new opening: whoever hid the surface
  // for themselves stays hidden.
  if (!wasOpen) surface.openRevision = surface.revision;
  answerAsks(state, "boardRequested", now);
  bumpRoom(state);
}

/**
 * What an ask wanted happened — the board opened, transcription turned off —
 * so every ask for it has its answer.
 */
function answerAsks(
  state: MeetingState,
  ask: "boardRequested" | "transcriptionStopRequested",
  now: number,
): void {
  for (const admission of Object.values(state.admissions)) {
    if (!admission[ask]) continue;
    admission[ask] = false;
    touch(admission, now);
  }
}

function closeSurface(state: MeetingState, now: number): void {
  const { surface } = state;
  if (surface.focus) owePin(state, surface.focus, now);
  surface.open = false;
  surface.revision += 1;
  bumpRoom(state);
}

function owePin(state: MeetingState, focus: SurfaceFocus, now: number): void {
  const { surface } = state;
  surface.pins[focus.usageId] = {
    ...focus,
    // Unique per boundary; the sync server and the capture key both accept it.
    commandId: `wbpin-${surface.revision + 1}-${focus.usageId}`,
    owedAt: now,
  };
}

/**
 * A pin the sync server could not take for a day is given up: the capture
 * then keeps the board's previous pin, or records that nothing was shared.
 */
function giveUpStalePins(state: MeetingState, now: number): void {
  for (const [usageId, pin] of Object.entries(state.surface.pins)) {
    if (now - pin.owedAt >= WHITEBOARD_PIN_GIVE_UP_MS) delete state.surface.pins[usageId];
  }
}

function stopEgressWhenEnded(state: MeetingState): void {
  state.egress.desired = null;
  state.egress.target = null;
}

function place(state: MeetingState, nodeId: string, now: number): void {
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
function abandonNode(state: MeetingState, reason: string, now: number): void {
  for (const attempt of Object.values(state.attempts)) {
    if (attempt.nodeId !== state.meta.nodeId) continue;
    endAttempt(attempt, reason, now);
    attempt.removed = true;
  }
  const egress = state.egress;
  if (egress.egressId || egress.op || egress.desired) {
    egress.egressId = null;
    egress.mode = null;
    egress.status = null;
    egress.startedAt = null;
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
function nodeUnreachable(state: MeetingState, now: number): boolean {
  const since = state.room.unreachableSince;
  return since !== null && now - since >= MEDIA_NODE_UNREACHABLE_GRACE_MS;
}

function planEgressStart(state: MeetingState, now: number, outcome: Outcome): void {
  const egress = state.egress;
  if (!isOpen(state) || !egress.desired || egress.egressId || egress.op) return;
  if (state.retries["egress.start"] && state.retries["egress.start"].retryAt > now) return;
  const anyoneInRoom = Object.values(state.attempts).some(
    (attempt) => attempt.endedAt === null && attempt.joinedAt !== null,
  );
  const placement = placementOf(state);
  if (!anyoneInRoom || !placement) return;
  egress.opSeq += 1;
  egress.op = {
    id: `${state.meta.meetingId}:${egress.opSeq}`,
    kind: "start",
    startedAt: now,
    mode: egress.desired,
    target: egress.target,
  };
  outcome.once.push({
    key: "egress.start",
    kind: "livekit.startEgress",
    placement,
    opId: egress.op.id,
    mode: egress.desired,
    target: egress.target,
  });
}

/**
 * Apply a user's Space authority as read no earlier than `readAt`. A read
 * requested before an admission's role last changed (a periodic check that
 * was in flight when a change was pushed) is not applied over it. Only a
 * change is stamped, so a read that finds the role as it was keeps nothing.
 */
function applyAuthority(
  state: MeetingState,
  userId: string,
  spaceRole: Admission["spaceRole"],
  reason: string,
  readAt: number,
  now: number,
): void {
  const revoked = state.meta.spaceKind === "shared" && spaceRole === "visitor";
  for (const admission of Object.values(state.admissions)) {
    if (admission.userId !== userId || admission.spaceRoleAt > readAt) continue;
    if (revoked) {
      if (admission.status === "approved" || admission.status === "pending") {
        decide(state, admission, "revoked", null, reason, now);
      }
      continue;
    }
    if (admission.spaceRole !== spaceRole) {
      admission.spaceRole = spaceRole;
      admission.spaceRoleAt = readAt;
      touch(admission, now);
    }
  }
}

function revokeUser(state: MeetingState, userId: string, reason: string, now: number): void {
  for (const admission of Object.values(state.admissions)) {
    if (admission.userId !== userId) continue;
    if (admission.status === "approved" || admission.status === "pending") {
      decide(state, admission, "revoked", null, reason, now);
    }
  }
}

/**
 * Keep a removed participant out: a user by id, a guest by their network.
 * A guest whose network was unknown cannot be kept out, and the caller is told.
 */
/**
 * Keep out whoever `admission` belongs to, for the rest of the meeting: a
 * user by account, a guest by the network they joined from. Every live
 * admission the bar covers is revoked with it, so none of them is a way back
 * in; {@link refuseBarred} turns away whatever asks afterwards.
 */
function bar(state: MeetingState, admission: Admission, decidedByUserId: string | null, now: number): KeptOut {
  const { barred } = state;
  let keptOut: KeptOut = "none";
  if (admission.userId) {
    remember(barred.userIds, admission.userId);
    keptOut = "account";
  } else if (admission.networkKey) {
    remember(barred.guestNetworks, admission.networkKey);
    keptOut = "network";
  }
  for (const covered of keptOutBy(state, admission)) {
    if (covered.status === "approved" || covered.status === "pending") {
      decide(state, covered, "revoked", decidedByUserId, "removed_by_moderator", now);
    }
  }
  return keptOut;
}

/**
 * The admissions a bar on `admission`'s owner reaches: every one of the
 * user's, or every guest's that came from the same network. A guest a
 * moderator made a moderator was let in deliberately and is not reached
 * through a network they share.
 */
function keptOutBy(state: MeetingState, admission: Admission): Admission[] {
  return Object.values(state.admissions).filter((candidate) => {
    if (candidate.id === admission.id) return true;
    if (admission.userId) return candidate.userId === admission.userId;
    return admission.networkKey !== null &&
      candidate.userId === null &&
      candidate.networkKey === admission.networkKey &&
      roleOf(state, candidate) === "attendee";
  });
}

/** The strongest role any of `admissions` holds in the meeting now. */
function strongestRole(state: MeetingState, admissions: readonly Admission[]): MeetingRole {
  let strongest: MeetingRole = "attendee";
  for (const admission of admissions) {
    if (admission.status !== "approved") continue;
    const role = roleOf(state, admission);
    if (role === "host") return role;
    if (role === "moderator") strongest = role;
  }
  return strongest;
}

function remember(list: string[], value: string): void {
  if (list.includes(value)) return;
  list.push(value);
  if (list.length > BARRED_MEMORY) list.shift();
}

/**
 * Refuse a join by someone a moderator removed, whichever admission it names.
 * A barred network turns away only attendee guests: whoever signs in is known
 * by their own account, and a guest made moderator was let in deliberately.
 */
function refuseBarred(
  state: MeetingState,
  subject: Subject,
  admission: Admission | undefined,
  guestNetworkKey: string | null,
): void {
  const { barred } = state;
  if (subject.kind === "user" && barred.userIds.includes(subject.userId)) {
    throw Errors.MEETING_ADMISSION_DENIED("A moderator removed you from this meeting.");
  }
  if (
    subject.kind === "guest" &&
    guestNetworkKey &&
    barred.guestNetworks.includes(guestNetworkKey) &&
    (!admission || roleOf(state, admission) === "attendee")
  ) {
    throw Errors.MEETING_ADMISSION_DENIED(
      "This meeting isn't accepting guests from your network. Sign in to ask to join.",
    );
  }
}

// ─── Access ──────────────────────────────────────────────────────────────────

function ownsAdmission(subject: Subject, admission: Admission): boolean {
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
function liveAdmissionOf(state: MeetingState, userId: string): Admission | undefined {
  let live: Admission | undefined;
  for (const admission of Object.values(state.admissions)) {
    if (admission.userId !== userId) continue;
    if (admission.status !== "pending" && admission.status !== "approved") continue;
    if (!live || admission.createdAt > live.createdAt) live = admission;
  }
  return live;
}

/** Whether `attemptId` is one of the subject's own attempts that pruning forgot. */
function ownPrunedAttempt(state: MeetingState, subject: Subject, attemptId: string): boolean {
  const admissionId = state.attempts[attemptId] ? undefined : state.prunedAttempts[attemptId]?.admissionId;
  const admission = admissionId ? state.admissions[admissionId] : undefined;
  if (!admission) return false;
  if (!ownsAdmission(subject, admission)) throw Errors.FORBIDDEN();
  return true;
}

function ownAttempt(state: MeetingState, subject: Subject, attemptId: string): Attempt {
  // A forgotten attempt of the subject's own is over, which is what any
  // request naming it is told.
  if (ownPrunedAttempt(state, subject, attemptId)) throw Errors.MEETING_CONNECTION_CLOSED();
  const attempt = state.attempts[attemptId];
  const admission = attempt ? state.admissions[attempt.admissionId] : undefined;
  if (!attempt || !admission) throw Errors.NOT_FOUND("Participant");
  if (!ownsAdmission(subject, admission)) throw Errors.FORBIDDEN();
  return attempt;
}

function ownApprovedAdmission(state: MeetingState, subject: Subject, attemptId: string): Admission {
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
function requireModerator(state: MeetingState, subject: Subject): { userId: string | null; host: boolean } {
  if (!isOpen(state)) throw Errors.NOT_FOUND("Meeting");
  const seated = seatedAdmissionOf(state, subject);
  if (!seated || !canModerate(state, seated)) throw Errors.FORBIDDEN();
  return { userId: seated.userId, host: roleOf(state, seated) === "host" };
}

/** One of the Space's owner and admins, as the Worker read them for this request. */
function isAdmin(subject: Subject): subject is Extract<Subject, { kind: "user" }> {
  return subject.kind === "user" && subject.spaceRole === "admin";
}

/**
 * A host acts from their seat. With `fromOutside`, the Space's owner and
 * admins may also act without one: ending or renaming their Space's meeting
 * is Space authority, used from the Space's pages.
 */
function requireHost(
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

function egressView(state: MeetingState, forModerator: boolean): EgressView {
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

function view(state: MeetingState, admission: Admission, attempt: Attempt): ParticipantView {
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
    grant: grantFor(state, admission),
    room: roomMetadataFor(state),
    recordingEnabled: state.meta.recordingEnabled,
    egress: egressView(state, canModerate(state, admission)),
  };
}

// ─── Small helpers ───────────────────────────────────────────────────────────

function attemptByIdentity(state: MeetingState, identity: string): Attempt | undefined {
  return Object.values(state.attempts).find((attempt) => attempt.identity === identity);
}

function addStray(state: MeetingState, identity: string): void {
  if (!state.room.strays.includes(identity)) state.room.strays.push(identity);
}

/**
 * An egress the meeting tracks is never a stray: a start's late reply naming
 * the egress a room lookup already adopted for it describes the same egress.
 */
function addStrayEgress(state: MeetingState, egressId: string): void {
  if (egressId === state.egress.egressId) return;
  if (!state.egress.strays.includes(egressId)) state.egress.strays.push(egressId);
}

function touch(admission: Admission, now: number): void {
  admission.updatedAt = Math.max(now, admission.createdAt);
}

function bumpRoom(state: MeetingState): void {
  state.room.version += 1;
}

function bumpEgress(state: MeetingState): void {
  state.egress.revision += 1;
  bumpRoom(state);
}
