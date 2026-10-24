import { whiteboardGrantPrincipalKey } from "@orbmeet/whiteboard-core/whiteboard-grant-principal";
import {
  ADMISSION_PENDING_TTL_MS,
  AUTHORITY_CHECK_MS,
  CONVERGING_TICK_MS,
  EGRESS_START_RESULT_TIMEOUT_MS,
  EMPTY_MEETING_GRACE_MS,
  END_NOTICE_GRACE_MS,
  ISSUE_GRACE_MS,
  MEDIA_NODE_UNREACHABLE_GRACE_MS,
  PRESENCE_CHECK_MS,
  WHITEBOARD_PIN_START_WINDOW_MS,
  grantFor,
  grantHash,
  isOpen,
  managesWhiteboards,
  placementOf,
  roomMetadataFor,
  whiteboardAuthorityHash,
  type MeetingState,
} from "./model";
import type { Effect } from "./protocol";

/**
 * Everything the outside world should be told or asked, derived from state
 * alone. Planned again on every tick, so each effect is idempotent and one
 * lost to a crash simply comes back. Effects in retry backoff wait their turn.
 */
export function plan(state: MeetingState, now: number): Effect[] {
  return wantedEffects(state, now).filter((effect) => {
    const retry = state.retries[effect.key];
    return !retry || retry.retryAt <= now;
  });
}

/**
 * The keys whose retry backoff still means something: every effect the state
 * calls for, and the egress start `step` issues once while a start is wanted.
 */
export function wantedEffectKeys(state: MeetingState, now: number): Set<string> {
  const keys = new Set(wantedEffects(state, now).map((effect) => effect.key));
  if (isOpen(state) && state.egress.desired && !state.egress.egressId) keys.add("egress.start");
  return keys;
}

/** Every effect the state calls for, whether or not it is backing off. */
function wantedEffects(state: MeetingState, now: number): Effect[] {
  const effects = new Map<string, Effect>();
  const add = (effect: Effect) => {
    if (!effects.has(effect.key)) effects.set(effect.key, effect);
  };
  const { meta, egress, room } = state;
  if (meta.phase === "drained") return [];

  const attempts = Object.values(state.attempts);
  const anyoneInRoom = attempts.some((a) => a.endedAt === null && a.joinedAt !== null);
  // Every effect on the media node is planned for the placement it acts on.
  const placement = placementOf(state);

  if (isOpen(state) && placement) {
    for (const attempt of attempts) {
      if (attempt.endedAt !== null || attempt.joinedAt === null) continue;
      const admission = state.admissions[attempt.admissionId];
      if (!admission) continue;
      const grant = grantFor(state, admission);
      const hash = grantHash(grant);
      if (hash !== attempt.appliedGrant) {
        add({
          key: `grant:${attempt.id}`,
          kind: "livekit.grant",
          placement,
          attemptId: attempt.id,
          sid: attempt.sid,
          identity: attempt.identity,
          grant,
          hash,
        });
      }
    }
    if (presenceDue(state, now)) {
      add({ key: "presence", kind: "livekit.listParticipants", placement, requestedAt: now });
    }
    const seatedUsers = seatedUserIds(state);
    if (seatedUsers.length > 0 && authorityCheckDue(state, now)) {
      add({ key: "authority", kind: "space.authority", userIds: seatedUsers, requestedAt: now });
    }
    if (anyoneInRoom && room.version > room.appliedVersion) {
      add({
        key: "metadata",
        kind: "livekit.roomMetadata",
        placement,
        room: room.instance,
        version: room.version,
        metadata: roomMetadataFor(state),
      });
    }
  }

  // An ended meeting tells the people it is about to remove that it ended.
  const noticePending = endNoticePending(state, now);
  if (placement && noticePending) {
    add({
      key: "metadata",
      kind: "livekit.roomMetadata",
      placement,
      room: room.instance,
      version: room.version,
      metadata: roomMetadataFor(state),
    });
  }

  // The presented board's sync room re-reads an admission whose authority
  // changed, whatever changed it. Other presented boards catch up on their
  // own periodic check, and their sockets are asked to follow the focus.
  const focus = state.surface.focus;
  if (isOpen(state) && focus) {
    for (const admission of Object.values(state.admissions)) {
      const hash = whiteboardAuthorityHash(state, admission);
      if (hash === admission.whiteboardAuthority) continue;
      add({
        key: `whiteboard.authority:${admission.id}`,
        kind: "whiteboard.authority",
        admissionId: admission.id,
        syncRoomId: focus.syncRoomId,
        principalKey: whiteboardGrantPrincipalKey(
          admission.userId
            ? { type: "user", id: admission.userId }
            : { type: "guest_admission", id: admission.id },
        ),
        narrowed: !managesWhiteboards(state, admission),
        hash,
      });
    }
  }

  // Pins outlive the meeting: the capture job waits for them.
  for (const pin of Object.values(state.surface.pins)) {
    add({
      key: `whiteboard.pin:${pin.usageId}`,
      kind: "whiteboard.pin",
      meetingId: meta.meetingId,
      pin: {
        usageId: pin.usageId,
        whiteboardId: pin.whiteboardId,
        syncRoomId: pin.syncRoomId,
        commandId: pin.commandId,
        startBefore: pin.owedAt + WHITEBOARD_PIN_START_WINDOW_MS,
      },
    });
  }

  if (placement) {
    const remove = (identity: string) =>
      add({ key: `remove:${identity}`, kind: "livekit.remove", placement, identity });
    // Held while the end notice is on its way: removed first, a participant
    // takes it for a kick and asks to join again.
    if (!noticePending) {
      for (const attempt of attempts) {
        if (attempt.endedAt !== null && attempt.joinedAt !== null && !attempt.removed) remove(attempt.identity);
      }
    }
    for (const identity of room.strays) remove(identity);

    // Webhooks only hint. A tracked egress is looked up often while it
    // changes, and slowly while it runs, so one that ended unseen is noticed.
    const opLost = egress.op !== null && now - egress.op.startedAt >= EGRESS_START_RESULT_TIMEOUT_MS;
    if ((opLost || egress.egressId) && egressPollDue(state, now)) {
      add({ key: "egress.list", kind: "livekit.listEgress", placement });
    }
    const stop = (egressId: string) =>
      add({ key: `egress.stop:${egressId}`, kind: "livekit.stopEgress", placement, egressId });
    if (egress.egressId && egress.desired === null && egress.status !== "stopping") stop(egress.egressId);
    for (const egressId of egress.strays) stop(egressId);
  }

  if (meta.phase === "ended") {
    const egressIdle = !egress.egressId && !egress.op;
    if (meta.endReason === "discarded") {
      if (!state.finalized) add({ key: "discard", kind: "meeting.discard" });
    } else {
      if (!state.finalized) add({ key: "finalize", kind: "meeting.finalize", reason: meta.endReason ?? "system" });
      else {
        if (!state.postMeetingDone) add({ key: "post", kind: "meeting.postTasks" });
        // Captures read the pins, so they start once every pin has landed or
        // been given up.
        if (!state.surface.captureStarted && Object.keys(state.surface.pins).length === 0) {
          add({ key: "whiteboard.capture", kind: "whiteboard.capture" });
        }
      }
    }
    if (placement && !room.deleted && egressIdle) add({ key: "room.delete", kind: "livekit.deleteRoom", placement });
    if (readyToDrain(state)) add({ key: "drain", kind: "meeting.drain" });
  }
  return [...effects.values()];
}

/**
 * Whether an ended meeting is still telling its room that it ended: someone
 * is left to remove, the room does not hold the notice yet, and the grace for
 * it has not run out.
 */
function endNoticePending(state: MeetingState, now: number): boolean {
  const { meta, room } = state;
  return (
    meta.phase === "ended" &&
    meta.endedAt !== null &&
    now - meta.endedAt < END_NOTICE_GRACE_MS &&
    !room.deleted &&
    room.version > room.appliedVersion &&
    Object.values(state.attempts).some((a) => a.endedAt !== null && a.joinedAt !== null && !a.removed)
  );
}

function egressPollDue(state: MeetingState, now: number): boolean {
  const { egress } = state;
  return egress.lastPolledAt === null || now - egress.lastPolledAt >= egressPollInterval(state);
}

function egressPollInterval(state: MeetingState): number {
  const { egress } = state;
  return egress.op || egress.status === "starting" || egress.status === "stopping"
    ? CONVERGING_TICK_MS
    : PRESENCE_CHECK_MS;
}

/** Users with an approved admission and an attempt that has not ended, sorted. */
function seatedUserIds(state: MeetingState): string[] {
  const users = new Set<string>();
  for (const attempt of Object.values(state.attempts)) {
    if (attempt.endedAt !== null) continue;
    const admission = state.admissions[attempt.admissionId];
    if (admission?.userId && admission.status === "approved") users.add(admission.userId);
  }
  return [...users].sort();
}

function authorityCheckDue(state: MeetingState, now: number): boolean {
  const last = state.room.lastAuthorityCheckAt;
  return last === null || now - last >= AUTHORITY_CHECK_MS;
}

/**
 * Whether the room should be listed now: on the presence interval while anyone
 * is in or on the way, sooner while someone is missing, and as soon as an
 * attempt nobody has seen join outlives its grace with no listing requested
 * since. Only that listing may end it (see `reconcilePresence`).
 */
function presenceDue(state: MeetingState, now: number): boolean {
  const active = Object.values(state.attempts).filter((a) => a.endedAt === null);
  if (active.length === 0) return false;
  const last = state.room.lastPresenceCheckAt;
  if (last === null) return true;
  if (active.some((a) => a.joinedAt === null && graceEnd(a) <= now && last < graceEnd(a))) return true;
  const unsettled = active.some((a) => a.absentSince !== null);
  return now - last >= (unsettled ? CONVERGING_TICK_MS : PRESENCE_CHECK_MS);
}

/** When an issued attempt the room has not shown becomes due a look. */
function graceEnd(attempt: { issuedAt: number }): number {
  return attempt.issuedAt + ISSUE_GRACE_MS;
}

export function readyToDrain(state: MeetingState): boolean {
  const { meta, egress, room } = state;
  const settled = meta.endReason === "discarded"
    ? state.finalized
    : state.finalized && state.postMeetingDone && state.surface.captureStarted;
  return (
    meta.phase === "ended" &&
    settled &&
    !egress.egressId &&
    !egress.op &&
    egress.strays.length === 0 &&
    room.strays.length === 0 &&
    Object.keys(state.surface.pins).length === 0 &&
    (room.deleted || !meta.nodeId) &&
    Object.values(state.attempts).every((a) => a.removed || a.joinedAt === null)
  );
}

/** When time next changes something, or null when nothing is waiting on it. */
export function nextWakeAt(state: MeetingState, now: number): number | null {
  const { meta, egress, room } = state;
  if (meta.phase === "drained") return null;
  const candidates: number[] = [];
  const at = (time: number) => candidates.push(Math.max(time, now + 250));

  // A retry already due was planned by the commit that found it due.
  for (const retry of Object.values(state.retries)) {
    if (retry.retryAt > now) at(retry.retryAt);
  }

  if (isOpen(state)) {
    if (meta.maxDurationMs !== null) at(meta.startedAt + meta.maxDurationMs);
    const attempts = Object.values(state.attempts).filter((a) => a.endedAt === null);
    for (const attempt of attempts) {
      // A listing is due at the grace's end, unless one requested since ran.
      // Once due it is running or backing off (its retry is a candidate
      // already), so it is waited for, not spun on.
      const lastLook = room.lastPresenceCheckAt;
      if (attempt.joinedAt === null && (lastLook === null || lastLook < graceEnd(attempt))) {
        at(graceEnd(attempt) > now ? graceEnd(attempt) : now + CONVERGING_TICK_MS);
      }
    }
    for (const admission of Object.values(state.admissions)) {
      if (admission.status === "pending") at(admission.createdAt + ADMISSION_PENDING_TTL_MS);
    }
    if (seatedUserIds(state).length > 0) {
      // Like the presence check: a due check is running or backing off.
      const dueAt = (state.room.lastAuthorityCheckAt ?? now) + AUTHORITY_CHECK_MS;
      at(Math.max(dueAt, state.retries.authority?.retryAt ?? 0, now + CONVERGING_TICK_MS));
    }
    if (attempts.length > 0) {
      // Absent attempts are settled by the presence check, which then runs
      // on a converging tick. A check that is due is running or backing off,
      // so the next one is waited for, not spun on.
      const unsettled = attempts.some((a) => a.absentSince !== null);
      const dueAt = room.lastPresenceCheckAt === null
        ? now
        : room.lastPresenceCheckAt + (unsettled ? CONVERGING_TICK_MS : PRESENCE_CHECK_MS);
      at(Math.max(dueAt, state.retries.presence?.retryAt ?? 0, now + CONVERGING_TICK_MS));
    } else if (!Object.values(state.admissions).some((a) => a.status === "pending")) {
      at((room.emptySince ?? now) + EMPTY_MEETING_GRACE_MS);
    }
  }
  if (meta.nodeId && (egress.op || egress.egressId)) {
    // An unanswered start is looked up once its result is overdue; a
    // tracked egress on its poll interval. Never sooner than a converging
    // tick, so an overdue lookup still running does not spin the alarm.
    const lookupAt = egress.egressId
      ? (egress.lastPolledAt ?? now) + egressPollInterval(state)
      : egress.op!.startedAt + EGRESS_START_RESULT_TIMEOUT_MS;
    at(Math.max(lookupAt, now + CONVERGING_TICK_MS));
  }
  if (room.unreachableSince !== null) at(room.unreachableSince + MEDIA_NODE_UNREACHABLE_GRACE_MS);
  // Removals held for the end notice go once its grace runs out.
  if (endNoticePending(state, now)) at(meta.endedAt! + END_NOTICE_GRACE_MS);
  if (meta.phase === "ended") at(now + 60_000);
  return candidates.length > 0 ? Math.min(...candidates) : null;
}
