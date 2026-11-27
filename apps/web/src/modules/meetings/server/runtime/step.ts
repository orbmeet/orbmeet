import { Errors } from "@/lib/app-errors";
import { getTerminalAdmissionError } from "@/modules/meetings/server/lifecycle/join-results";
import {
  ADMISSION_PENDING_TTL_MS,
  EFFECT_RETRY_BASE_MS,
  EFFECT_RETRY_MAX_MS,
  EMPTY_MEETING_GRACE_MS,
  MAX_PENDING_ADMISSIONS,
  PRUNED_ATTEMPT_MEMORY,
  SCREEN_SHARE_ASK_TTL_MS,
  SETTLED_ATTEMPT_RETENTION_MS,
  holdsSeat,
  initialState,
  isCurrentPlacement,
  isOpen,
  roleOf,
  roleOnArrival,
  seatAvailable,
  surfaceViewFor,
  whiteboardAuthorityHash,
  type Admission,
  type Attempt,
  type MeetingState,
} from "./model";
import type {
  Command,
  EffectResult,
  EgressStartEffect,
  Input,
  Outcome,
  Reply,
} from "./protocol";
import { wantedEffectKeys } from "./plan";
import {
  addStrayEgress,
  bumpRoom,
  egressView,
  isAdmin,
  liveAdmissionOf,
  ownApprovedAdmission,
  ownAttempt,
  ownPrunedAttempt,
  ownsAdmission,
  requireHost,
  requireModerator,
  setScreenShare,
  touch,
  view,
} from "./state/access";
import {
  applyAuthority,
  bar,
  decide,
  endAttempt,
  keptOutBy,
  refuseBarred,
  revokeUser,
  strongestRole,
} from "./state/authority";
import {
  failEgress,
  planEgressStart,
  setEgress,
  settleEgress,
  startStillWanted,
  stopEgressWhenEnded,
} from "./state/egress";
import {
  abandonNode,
  endMeeting,
  nodeUnreachable,
  observe,
  place,
  reconcilePresence,
} from "./state/presence";
import {
  answerAsks,
  giveUpStalePins,
  present,
  setSurface,
} from "./state/surface";

export interface Applied {
  state: MeetingState;
  /** The last kept input's reply. */
  reply?: Reply;
  once: EgressStartEffect[];
  /** What refused the input that stopped the run, if one did. */
  refusal?: unknown;
}

/** How a change is applied, as the room's storage allows. */
export interface StepOptions {
  /**
   * Whether settled records may be forgotten (`pruneSettled`): only while D1
   * shows the state the change starts from. A record forgotten while D1 lags
   * would never reach it, and D1 would keep showing it as it last saw it — a
   * departed participant still live, for good.
   */
  forgetSettled: boolean;
}

const DEFAULT_STEP_OPTIONS: StepOptions = { forgetSettled: true };

/**
 * Apply a request's inputs in order, the way the room commits them. Each input
 * steps its own copy, kept only when it returns, so a refused input keeps
 * nothing it did before refusing; the inputs before it are kept, and time
 * still moves on. `state` itself is never changed.
 */
export function applyInputs(
  state: MeetingState,
  inputs: readonly Input[],
  now: number,
  options: StepOptions = DEFAULT_STEP_OPTIONS,
): Applied {
  const applied: Applied = { state, once: [] };
  for (const input of inputs) {
    try {
      const stepped = step(structuredClone(applied.state), input, now, options);
      applied.state = stepped.state;
      applied.reply = stepped.outcome.reply;
      applied.once.push(...stepped.outcome.once);
    } catch (error) {
      applied.refusal = error;
      const ticked = step(structuredClone(applied.state), { kind: "tick" }, now, options);
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
export function step(
  state: MeetingState | null,
  input: Input,
  now: number,
  options: StepOptions = DEFAULT_STEP_OPTIONS,
): {
  state: MeetingState;
  outcome: Outcome;
} {
  if (input.kind === "init") {
    return { state: state ?? initialState(input.snapshot, now), outcome: { once: [] } };
  }
  if (!state) throw Errors.NOT_FOUND("Meeting");
  const outcome: Outcome = { once: [] };
  advance(state, now, outcome, options);
  dispatch(state, input, now, outcome);
  advance(state, now, outcome, options);
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

function advance(state: MeetingState, now: number, outcome: Outcome, options: StepOptions): void {
  if (options.forgetSettled) pruneSettled(state, now);
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
    // A request lives as long as the attempt that made it, which holds the
    // capture it is for, and no longer than the wait for an answer.
    if (admission.screenShare === "requested") {
      const ask = admission.screenShareAsk;
      const asker = ask ? state.attempts[ask.attemptId] : undefined;
      if (!ask || !asker || asker.endedAt !== null || now - ask.at >= SCREEN_SHARE_ASK_TTL_MS) {
        setScreenShare(admission, "none", now);
      }
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

function pendingCount(state: MeetingState): number {
  let count = 0;
  for (const admission of Object.values(state.admissions)) if (admission.status === "pending") count += 1;
  return count;
}

/**
 * Forget what is over: attempts that ended and left the room, approval
 * requests that expired (a pending admission never has attempts), and
 * guests' admissions none of whose attempts is remembered. Their rows are
 * final in D1, so keeping them would only grow the state for as long as the
 * meeting runs — with every request anyone ever made. A late webhook for a
 * forgotten identity is treated like any unknown one: removed from the room;
 * a guest naming a forgotten request asks again, as a signed-in user does.
 */
function pruneSettled(state: MeetingState, now: number): void {
  const withAttempts = new Set(Object.values(state.attempts).map((attempt) => attempt.admissionId));
  for (const [id, admission] of Object.entries(state.admissions)) {
    if (now - admission.updatedAt < SETTLED_ATTEMPT_RETENTION_MS) continue;
    if (admission.status === "expired") delete state.admissions[id];
    // A guest's admission is a cookie's, and every first join with a new
    // cookie makes one: kept for good, they would grow the state with every
    // visit for as long as the meeting runs. Once none of its attempts is
    // remembered it is forgotten like an expired request; the guest asks
    // again. A bar is kept on the guest's network, not on the admission.
    else if (admission.userId === null && admission.status !== "pending" && !withAttempts.has(id)) {
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
        endAttempt(state, attempt, "released", now);
      }
      return { kind: "ok" };
    }
    case "leave": {
      if (ownPrunedAttempt(state, input.subject, input.attemptId)) return { kind: "left", found: false };
      const attempt = ownAttempt(state, input.subject, input.attemptId);
      endAttempt(state, attempt, "voluntary", now);
      // Found: this leave, or the same one repeated, ended it. An attempt
      // ended otherwise (taken over by another tab) was not this leave's.
      return { kind: "left", found: attempt.endReason === "voluntary" };
    }
    case "authorize": {
      if (input.as === "host") requireHost(state, input.subject);
      else requireModerator(state, input.subject);
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
      if (roleOf(state, admission) === "attendee" && (admission.screenShare === "none" || admission.screenShare === "declined")) {
        setScreenShare(admission, "requested", now, { attemptId: input.attemptId, at: now });
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
      // A decision answers a request that is still open. One that lands after
      // the attendee withdrew changes nothing; refusing a grant takes it back.
      if (target.screenShare === "requested") {
        setScreenShare(target, input.allow ? "granted" : "declined", now);
      } else if (target.screenShare === "granted" && !input.allow) {
        setScreenShare(target, "none", now);
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
      setScreenShare(admission, "none", now);
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
  // they neither take a second seat nor wait for approval again. A named
  // admission this meeting does not know (a tab's id from an earlier meeting on
  // the same link) is no admission at all.
  const namedAdmission: Admission | undefined = input.admissionId ? state.admissions[input.admissionId] : undefined;
  let admission = repeatedGuest
    ?? namedAdmission
    ?? (subject.kind === "user" ? liveAdmissionOf(state, subject.userId) : undefined);
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
      screenShareRevision: 0,
      screenShareAsk: null,
      boardEdit: false,
      boardRequested: false,
      transcriptionStopRequested: false,
      hand: null,
      whiteboardAuthority: "",
    };
    const hosting = hosts(created);
    if (meta.joinPolicy === "closed" && !hosting) throw Errors.MEETING_CLOSED();
    const approved = hosting || meta.joinPolicy === "open";
    if (!approved && pendingCount(state) >= MAX_PENDING_ADMISSIONS) {
      throw Errors.PLAN_LIMIT_REACHED("Too many people are waiting to join. Try again in a few minutes.");
    }
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
    } else {
      // Closing the door keeps new entrants out, not those already waiting:
      // a host may still admit them (`decideAdmission`), so they keep waiting.
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

  // Placement goes with the join it came with: this join is let in, so the
  // meeting goes where it said, unless a join committed meanwhile placed or
  // moved it already. A move ends the attempts on the node it leaves, which
  // frees their seats before this one asks for its own.
  if (input.placement && meta.nodeId === input.placement.from) place(state, input.placement.nodeId, now);
  if (!holdsSeat(state, admission.id) && !seatAvailable(state, admission)) {
    throw Errors.PLAN_LIMIT_REACHED("Meeting is full");
  }
  if (!meta.nodeId) throw Errors.MEDIA_UNAVAILABLE();

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
    endedRole: null,
    sid: null,
    sessionJoinedAt: null,
    sidKnownSince: null,
    absentSince: null,
    captionLanguage: input.captionLanguage,
    // No session yet. Its join token is minted from the reply below, which
    // states the grant as it is once this attempt holds its seat.
    appliedGrant: null,
    removed: false,
  };
  state.attempts[attempt.id] = attempt;
  state.room.emptySince = null;
  return { kind: "admitted", participant: view(state, admission, attempt), newGuestAdmission };
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
    case "grantApplied": {
      // Applied to the session it was planned for. A session that has
      // replaced it since holds an unknown grant, which is planned anew.
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
      egress.knownSince = now;
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
