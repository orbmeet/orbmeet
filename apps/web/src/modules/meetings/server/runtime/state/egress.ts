import { Errors } from "@/lib/app-errors";
import {
  EGRESS_START_TIMEOUT_MS,
  isOpen,
  placementOf,
  type EgressMode,
  type EgressState,
  type MeetingState,
} from "../model";
import type { ObservedEgress, Outcome } from "../protocol";
import { addStrayEgress, bumpEgress, bumpRoom } from "./access";

export function setEgress(
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
  if (egress.desired !== mode && egress.mode !== mode) return;
  egress.desired = null;
  egress.target = null;
}

/**
 * What a look at the room's egresses says. `listedAt` is when a complete
 * listing was asked for, null for a webhook's word on one egress.
 */
export function observeEgress(
  state: MeetingState,
  observed: ObservedEgress[],
  listedAt: number | null,
  now: number,
): void {
  const egress = state.egress;
  const complete = listedAt !== null;
  egress.lastPolledAt = now;
  if (complete) state.room.unreachableSince = null;

  if (egress.op && !egress.egressId && listedAt !== null && listedAt >= egress.op.startedAt) {
    const orphan = observed.find(
      (info) => (info.status === "starting" || info.status === "active") && !egress.strays.includes(info.egressId),
    );
    if (orphan && startStillWanted(egress, egress.op)) {
      egress.egressId = orphan.egressId;
      egress.mode = egress.desired;
      egress.status = "starting";
      egress.startedAt = egress.op.startedAt;
      egress.knownSince = listedAt;
    } else if ((state.retries["egress.start"]?.failures ?? 0) >= 3) {
      failEgress(state, "LiveKit egress could not be started.");
    }
    egress.op = null;
  }

  const startUnanswered = egress.op !== null && !egress.egressId;
  for (const info of observed) {
    if (info.egressId === egress.egressId) continue;
    if (info.status === "complete" || info.status === "failed") {
      egress.strays = egress.strays.filter((egressId) => egressId !== info.egressId);
      continue;
    }
    if (startUnanswered) continue;
    if (info.status === "starting" || info.status === "active") addStrayEgress(state, info.egressId);
  }

  const current = egress.egressId
    ? observed.find((info) => info.egressId === egress.egressId)
    : undefined;
  if (!egress.egressId) return;
  if (!current) {
    if (listedAt !== null && (egress.knownSince === null || listedAt >= egress.knownSince)) {
      settleEgress(state, "The recording service lost track of this egress.");
    }
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

export function settleEgress(state: MeetingState, error: string | null): void {
  const egress = state.egress;
  const announced = egress.lastFailure !== null;
  const expected = egress.desired === null;
  egress.egressId = null;
  egress.mode = null;
  egress.status = null;
  egress.startedAt = null;
  egress.knownSince = null;
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
export function startStillWanted(egress: EgressState, op: NonNullable<EgressState["op"]>): boolean {
  return egress.desired === op.mode && egress.target === op.target;
}

export function failEgress(state: MeetingState, message: string): void {
  const egress = state.egress;
  egress.desired = null;
  egress.target = null;
  egress.lastFailure = message;
  egress.transition = "failed";
  bumpEgress(state);
}

export function stopEgressWhenEnded(state: MeetingState): void {
  state.egress.desired = null;
  state.egress.target = null;
}

export function planEgressStart(state: MeetingState, now: number, outcome: Outcome): void {
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
