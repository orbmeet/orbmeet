import { Errors } from "@/lib/app-errors";
import type { MeetingRole } from "@/modules/meetings/contract/constants";
import {
  BARRED_MEMORY,
  roleOf,
  type Admission,
  type Attempt,
  type MeetingState,
} from "../model";
import type { KeptOut, Subject } from "../protocol";
import { admissionTime, bumpRoom, setScreenShare, touch } from "./access";

/**
 * Each live attempt's role as the meeting stands now. A change that ends
 * several attempts reads them first: ending one before reading the next could
 * move the stand-in to an attempt ending in the same change, and record it as
 * the host it never was.
 */
export function liveRoles(state: MeetingState): Map<string, MeetingRole> {
  return new Map(Object.values(state.attempts)
    .filter((attempt) => attempt.endedAt === null)
    .map((attempt) => [attempt.id, roleOf(state, state.admissions[attempt.admissionId])]));
}

export function endAttempt(
  state: MeetingState,
  attempt: Attempt,
  reason: string,
  now: number,
  role: MeetingRole = roleOf(state, state.admissions[attempt.admissionId]),
): void {
  if (attempt.endedAt !== null) return;
  attempt.endedRole = role;
  attempt.endedAt = Math.max(now, attempt.joinedAt ?? attempt.issuedAt);
  attempt.endReason = reason;
  // Only an attempt that reached the room has anything to remove from it.
  attempt.removed = attempt.joinedAt === null;
}

export function decide(
  state: MeetingState,
  admission: Admission,
  status: "approved" | "denied" | "revoked" | "expired",
  decidedByUserId: string | null,
  reason: string | null,
  now: number,
): void {
  const wasPending = admission.status === "pending";
  // What its connections were, before this decision changes what it resolves to.
  const roleBefore = roleOf(state, admission);
  admission.status = status;
  admission.decidedByUserId = decidedByUserId;
  admission.decidedAt = admissionTime(admission, now);
  admission.decisionReason = reason;
  if (status !== "approved") {
    admission.moderator = false;
    setScreenShare(admission, "none", now);
    admission.boardEdit = false;
    admission.boardRequested = false;
    admission.transcriptionStopRequested = false;
    admission.hand = null;
    for (const attempt of Object.values(state.attempts)) {
      if (attempt.admissionId === admission.id && attempt.endedAt === null) {
        endAttempt(state, attempt, reason ?? status, now, roleBefore);
      }
    }
  }
  touch(admission, now);
  if (wasPending) {
    state.admissionsVersion += 1;
    bumpRoom(state);
  }
}

/**
 * Apply a user's Space authority as read no earlier than `readAt`. A read
 * requested before an admission's role last changed (a periodic check that
 * was in flight when a change was pushed) is not applied over it. Only a
 * change is stamped, so a read that finds the role as it was keeps nothing.
 */
export function applyAuthority(
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

export function revokeUser(state: MeetingState, userId: string, reason: string, now: number): void {
  for (const admission of Object.values(state.admissions)) {
    if (admission.userId !== userId) continue;
    if (admission.status === "approved" || admission.status === "pending") {
      decide(state, admission, "revoked", null, reason, now);
    }
  }
}

/**
 * Keep out whoever `admission` belongs to, for the rest of the meeting: a
 * user by account, a guest by the network they joined from.
 */
export function bar(state: MeetingState, admission: Admission, decidedByUserId: string | null, now: number): KeptOut {
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

/** The admissions a bar on `admission`'s owner reaches. */
/**
 * The admissions a bar on `admission`'s owner reaches: every one of the
 * user's, or every guest's that came from the same network. A guest a
 * moderator made a moderator was let in deliberately and is not reached
 * through a network they share.
 */
export function keptOutBy(state: MeetingState, admission: Admission): Admission[] {
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
export function strongestRole(state: MeetingState, admissions: readonly Admission[]): MeetingRole {
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
export function refuseBarred(
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
