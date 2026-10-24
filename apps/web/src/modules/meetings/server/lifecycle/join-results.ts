import { AppError, Errors } from "@/lib/app-errors";
import type { JoinMeetingResult } from "@/modules/meetings/contract/types";
import { isRetryableJoinCode } from "@/modules/meetings/contract/join-outcome";

/**
 * The closed-door error for an admission status, or null while it is still
 * live. The status is the discriminator — `decisionReason` is a free-text
 * audit note and never decides what the participant is told.
 */
export function getTerminalAdmissionError(
  admissionStatus: "approved" | "pending" | "denied" | "revoked" | "expired",
): AppError | null {
  switch (admissionStatus) {
    case "denied":
      return Errors.MEETING_ADMISSION_DENIED("A moderator denied your request to join.");
    case "revoked":
      return Errors.MEETING_ADMISSION_DENIED("You were removed from this meeting.");
    case "expired":
      return Errors.MEETING_ADMISSION_DENIED(
        "Your approval request expired. Ask the host to invite you again.",
      );
    case "approved":
    case "pending":
      return null;
  }
}

export function waitingForApproval(
  admissionId: string,
  meetingId: string,
): JoinMeetingResult {
  return {
    state: "waiting",
    reason: "approval",
    message: "Waiting for a moderator to admit you",
    admissionId,
    meetingId,
  };
}

export function appErrorToJoinMeetingResult(error: AppError): JoinMeetingResult {
  if (error.code === "MEETING_NOT_STARTED") {
    return {
      state: "waiting",
      reason: "meeting-start",
      message: "Meeting hasn't started yet.",
    };
  }

  return {
    state: "blocked",
    code: error.code,
    message: error.message,
    retryable: isRetryableJoinCode(error.code),
  };
}

/**
 * The answer for a join its coordinator refused as ended, given how the
 * entrant arrived.
 *
 * The coordinator ends a meeting before D1 finalizes it, and until then the
 * row still reads open, so the link cannot mint its next occurrence yet. A
 * fresh entry through a reusable link is about that next occurrence: it is
 * asked to retry rather than shown an ending it was never part of. A resume
 * (a stored admission), a one-time link, or a meeting this request just
 * started did belong to the meeting that ended.
 */
export function endedOccurrenceJoinError(entry: {
  startedNow: boolean;
  reusableLink: boolean;
  resuming: boolean;
}): AppError {
  return !entry.startedNow && entry.reusableLink && !entry.resuming
    ? Errors.CONFLICT("The previous meeting is still closing. Please try again in a moment.")
    : Errors.MEETING_ENDED();
}
