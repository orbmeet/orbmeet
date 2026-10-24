import {
  getErrorMessage,
  getServerErrorCode,
  getServerErrorStatusCode,
  isServerError,
} from "@/lib/error-inspection";
import { isRetryableJoinCode } from "@/modules/meetings/contract/join-outcome";
import type { JoinMeetingResult, JoinResult } from "@/modules/meetings/contract/types";

export type MeetingWaitingReason = "meeting-start" | "approval";

/**
 * Everything a join request can mean to the entry flow. Every join — the first
 * click, a lobby poll, an automatic rejoin, the recheck after a removal — is
 * classified here and nowhere else.
 */
export type JoinOutcome =
  | { kind: "admitted"; access: JoinResult }
  | { kind: "wait"; reason: MeetingWaitingReason; admissionId: string | null }
  | { kind: "retry"; code: string | null; message: string }
  | { kind: "final"; code: string | null; message: string };

const GENERIC_FAILURE = "Could not join meeting. Please try again.";

/** The server's wording when a plan's one running meeting is already taken. */
export function isConcurrentMeetingLimit(message: string | null | undefined): boolean {
  return /concurrent meeting/i.test(message ?? "");
}

/** The line printed for a refusal; the error screen adds its own copy per code. */
function getJoinFailureMessage(code: string | null | undefined, serverMessage = ""): string {
  switch (code) {
    case "MEETING_NOT_STARTED": return "Meeting hasn't started yet.";
    case "MEETING_ENDED": return "This meeting has ended.";
    case "MEETING_CLOSED": return "This meeting is closed to new participants.";
    case "MEETING_OPEN_ELSEWHERE": return "This meeting is open in another tab or device.";
    case "MEETING_ADMISSION_DENIED":
      return serverMessage || "A moderator denied your request to join.";
    case "PLAN_LIMIT_REACHED":
      // Two different refusals share the code: a full room, and a host whose
      // plan already has a meeting running. Only the server's words tell
      // them apart, so the second keeps its own.
      return isConcurrentMeetingLimit(serverMessage) ? serverMessage : "Meeting is full.";
    case "UNAUTHORIZED": return "Sign in to join this meeting.";
    case "FORBIDDEN":
      return serverMessage && serverMessage !== "Forbidden"
        ? serverMessage
        : "You don't have access to this meeting.";
    case "NOT_FOUND": return "This meeting is no longer available.";
    case "RATE_LIMITED": return "Too many attempts. Please try again later.";
    default: return GENERIC_FAILURE;
  }
}

/** A response the join endpoint returned. The server has already said whether a refusal is retryable. */
export function classifyJoinResponse(response: JoinMeetingResult): JoinOutcome {
  switch (response.state) {
    case "joined":
      if (!response.result.token || !response.result.serverUrl) {
        return { kind: "final", code: null, message: "Failed to get meeting credentials" };
      }
      return { kind: "admitted", access: response.result };
    case "waiting":
      if (response.reason === "approval" && !response.admissionId) {
        return { kind: "final", code: null, message: response.message };
      }
      return { kind: "wait", reason: response.reason, admissionId: response.admissionId ?? null };
    case "blocked":
      return {
        kind: response.retryable ? "retry" : "final",
        code: response.code,
        message: getJoinFailureMessage(response.code, response.message),
      };
  }
}

/**
 * A join request that threw. The endpoint returns every refusal it decides on,
 * so a throw is middleware (rate limiting, input validation) or infrastructure:
 * a Worker crash, a gateway error, Cloudflare's HTML error page, the network.
 * Only an application error that is known not to be retryable is final.
 */
export function classifyJoinError(error: unknown): JoinOutcome {
  const code = getServerErrorCode(error) ?? null;
  const message = getJoinFailureMessage(code, getErrorMessage(error, ""));
  if (!isServerError(error)) return { kind: "retry", code: null, message: GENERIC_FAILURE };
  if (isRetryableJoinCode(code)) return { kind: "retry", code, message };
  if ((getServerErrorStatusCode(error) ?? 0) >= 500) return { kind: "retry", code, message };
  return { kind: "final", code, message };
}

/**
 * The join endpoint answers FORBIDDEN whenever a stored reconnect admission id
 * no longer proves ownership (a guest whose cookie was cleared while
 * sessionStorage survived, or an id minted for a different signed-in user). The
 * response carries no reason beyond the code, so the caller retries once
 * without the id rather than trying to tell the causes apart.
 */
export function isStaleReconnectRejection(response: JoinMeetingResult): boolean {
  return response.state === "blocked" && response.code === "FORBIDDEN";
}
