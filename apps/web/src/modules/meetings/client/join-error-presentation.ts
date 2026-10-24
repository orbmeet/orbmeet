/**
 * How a failed join is presented.
 *
 * Rendering whatever string the server produced — "Meeting is full." — as the
 * entire screen next to a "Try again" button is wrong in three ways at once: it
 * states the failure without explaining it, it offers retry for outcomes
 * retrying cannot change (the meeting ended; you don't have access), and it
 * gives no route onward.
 *
 * Splitting title from detail, and marking which failures are actually
 * retryable, is what lets the screen be honest: a temporary problem gets a retry
 * button, a permanent one gets a way out instead.
 */

import { isConcurrentMeetingLimit } from "./entry/join-outcome";

export type JoinErrorKind =
  | "full"
  | "busy"
  | "ended"
  | "not-started"
  | "closed"
  | "elsewhere"
  | "denied"
  | "not-found"
  | "auth"
  | "rate-limited"
  | "unknown";

export interface JoinErrorPresentation {
  kind: JoinErrorKind;
  /** Short, human, sentence case. The one line someone will actually read. */
  title: string;
  /** What happened and what to do about it. */
  detail: string;
  /**
   * Whether retrying could plausibly succeed. False for outcomes that are
   * settled — showing a retry button there just invites a second failure.
   */
  canRetry: boolean;
  /** Label for the retry action when {@link canRetry}. */
  retryLabel: string;
}

export interface JoinErrorContext {
  /** The server's own message, where it carries a reason worth showing. */
  message?: string | null;
  /**
   * Whether the viewer has an account.
   *
   * Copy that points somewhere has to know who is reading it. "Its recording
   * and Summary will appear on the Meeting page" is useful to a member and a
   * dead end to a signed-out guest, who has no account and cannot open it —
   * and a guest link is the common way into these meetings, so that was the
   * usual reader.
   */
  isSignedIn?: boolean;
}

export function selectJoinErrorPresentation(
  code: string | null | undefined,
  context: JoinErrorContext = {},
): JoinErrorPresentation {
  const { message, isSignedIn = false } = context;
  switch (code) {
    case "PLAN_LIMIT_REACHED":
      // Starting a meeting while your plan's one running meeting is still
      // open used to say "This meeting is full — everyone allowed by the
      // host's plan is already in the meeting" to the host of an empty room.
      if (isConcurrentMeetingLimit(message)) {
        return {
          kind: "busy",
          title: "You already have a meeting running",
          detail:
            "Your plan runs one meeting at a time. Rejoin or end the one that’s live — it’s at the top of Meetings — then start this one.",
          canRetry: true,
          retryLabel: "Try again",
        };
      }
      return {
        kind: "full",
        title: "This meeting is full",
        detail:
          "Everyone allowed by the host's plan is already in the meeting. You'll get in as soon as someone leaves.",
        canRetry: true,
        retryLabel: "Try again",
      };
    case "MEETING_ENDED":
      return {
        kind: "ended",
        title: "This meeting has ended",
        // Same reasoning as `EndedMeetingNotice`, which reaches the identical
        // outcome when the meeting was already over on arrival: promise the
        // Meeting page only to someone who can open it.
        detail: isSignedIn
          ? "The host closed the Meeting. Its recording and Summary will appear on the Meeting page."
          : "The host closed the Meeting. You can close this tab.",
        canRetry: false,
        retryLabel: "Try again",
      };
    case "MEETING_NOT_STARTED":
      return {
        kind: "not-started",
        title: "This meeting hasn't started",
        detail: "The host hasn't opened it yet. Check back in a moment, or wait here and try again.",
        canRetry: true,
        retryLabel: "Check again",
      };
    case "MEETING_CLOSED":
      return {
        kind: "closed",
        title: "This meeting is closed",
        detail: "The host stopped letting new people in. Ask them to reopen it if you're expected.",
        canRetry: false,
        retryLabel: "Try again",
      };
    case "MEETING_OPEN_ELSEWHERE":
      return {
        kind: "elsewhere",
        // A statement of what happened, not an instruction: "Open in another
        // tab" read as something to go and do.
        title: "You moved to another tab or device",
        detail:
          "The meeting carried on there, and your mic and camera here are off. Carry on there, or bring it back to this screen.",
        canRetry: true,
        retryLabel: "Bring it back here",
      };
    case "MEETING_ADMISSION_DENIED":
      return {
        kind: "denied",
        title: "You weren't admitted",
        detail: message?.trim() || "A moderator declined your request to join this meeting.",
        canRetry: true,
        retryLabel: "Ask again",
      };
    case "NOT_FOUND":
      return {
        kind: "not-found",
        title: "This meeting link doesn't work",
        detail: "The link may have expired or been mistyped. Ask the host for a fresh one.",
        canRetry: false,
        retryLabel: "Try again",
      };
    case "UNAUTHORIZED":
      return {
        kind: "auth",
        title: "Sign in to join",
        detail: "This meeting is limited to signed-in people. Sign in and the link will work.",
        canRetry: false,
        retryLabel: "Try again",
      };
    case "FORBIDDEN":
      return {
        kind: "denied",
        title: "You don't have access",
        detail:
          message?.trim() ||
          "This meeting is restricted. Ask the host to invite the account you're signed in with.",
        canRetry: false,
        retryLabel: "Try again",
      };
    case "RATE_LIMITED":
      return {
        kind: "rate-limited",
        title: "Too many attempts",
        detail: "You've tried to join several times in quick succession. Wait a moment, then try again.",
        canRetry: true,
        retryLabel: "Try again",
      };
    default:
      return {
        kind: "unknown",
        title: "Couldn't join the meeting",
        // The raw message is kept as the detail here and only here: for an
        // unrecognised failure it is the only information we actually have.
        detail: message?.trim() || "Something went wrong on the way in. Trying again usually works.",
        canRetry: true,
        retryLabel: "Try again",
      };
  }
}
