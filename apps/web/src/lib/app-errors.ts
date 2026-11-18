/**
 * The refusals that describe a condition expected to clear on its own, so a
 * caller may ask again; every other code states a fact (denied, full, ended,
 * closed, signed out) that repeating the request will not change. The server
 * decides which is which by the code it throws, and a client reads it from
 * the code it receives — never from an HTTP status.
 *
 * - `CONFLICT`: a concurrent change won a compare-and-set, or something is
 *   mid-move (a meeting closing, a board moving between nodes).
 * - `MEETING_CONNECTION_CLOSED`: the connection a reconnect was re-issuing
 *   ended; the next attempt starts from the new state.
 * - `MEETING_BUSY`, `BUSY`: the work queued ahead of this request ran past its
 *   deadline; it was refused unapplied.
 * - `MEDIA_UNAVAILABLE`: no healthy media node yet, typically just after one
 *   was lost and before health checks move the meeting.
 * - `RATE_LIMITED`: throttled; retry, but slowly.
 * - `INTERNAL_ERROR`: an unexpected failure, surfaced without detail.
 */
const RETRYABLE_ERROR_CODES: ReadonlySet<string> = new Set([
  "CONFLICT",
  "MEETING_CONNECTION_CLOSED",
  "MEETING_BUSY",
  "BUSY",
  "MEDIA_UNAVAILABLE",
  "RATE_LIMITED",
  "INTERNAL_ERROR",
]);

/** Whether a refusal with this code may succeed if asked again. */
export function isRetryableErrorCode(code: string | null | undefined): boolean {
  return code != null && RETRYABLE_ERROR_CODES.has(code);
}

export class AppError<Data = unknown> extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode: number = 500,
    public data?: Data,
  ) {
    super(message);
    this.name = "AppError";
  }

  get retryable(): boolean {
    return isRetryableErrorCode(this.code);
  }
}

export const Errors = {
  /**
   * The one message an unexpected failure is allowed to show.
   *
   * Everything else on this object was written to be read by a user; this is
   * what a failure that was not gets replaced with before it reaches one.
   */
  INTERNAL: () =>
    new AppError("INTERNAL_ERROR", "Something went wrong. Please try again.", 500),
  UNAUTHORIZED: () => new AppError("UNAUTHORIZED", "Not authenticated", 401),
  FORBIDDEN: (message = "Access denied") => new AppError("FORBIDDEN", message, 403),
  NOT_FOUND: (resource = "Resource") =>
    new AppError("NOT_FOUND", `${resource} not found`, 404),
  MEETING_ENDED: () =>
    new AppError("MEETING_ENDED", "Meeting has ended", 410),
  MEETING_CONNECTION_CLOSED: () =>
    new AppError("MEETING_CONNECTION_CLOSED", "Meeting connection is no longer active", 409),
  MEETING_OPEN_ELSEWHERE: () =>
    new AppError("MEETING_OPEN_ELSEWHERE", "This meeting is open in another tab or device.", 409),
  CONFLICT: (message: string) => new AppError("CONFLICT", message, 409),
  MEETING_NOT_STARTED: () => new AppError("MEETING_NOT_STARTED", "Meeting hasn't started yet", 404),
  MEETING_CLOSED: () => new AppError("MEETING_CLOSED", "This meeting is closed to new participants", 403),
  MEETING_ADMISSION_DENIED: (message = "A moderator denied your request to join") =>
    new AppError("MEETING_ADMISSION_DENIED", message, 403),
  RATE_LIMITED: () =>
    new AppError("RATE_LIMITED", "Too many requests. Please try again later.", 429),
  PLAN_LIMIT_REACHED: (limit: string) =>
    new AppError("PLAN_LIMIT_REACHED", `Plan limit reached: ${limit}`, 403),
  VALIDATION: (message: string) =>
    new AppError("VALIDATION_ERROR", message, 400),
  // Standardized error codes for OAuth and config
  OAUTH_ERROR: (message: string) =>
    new AppError("OAUTH_ERROR", message, 400),
  ACCOUNT_LINK_REQUIRED: (message: string) =>
    new AppError("ACCOUNT_LINK_REQUIRED", message, 409),
  CONFIG_ERROR: (message: string) =>
    new AppError("CONFIG_ERROR", message, 500),
  /** The meeting's room had more queued than it could answer in time; the caller may ask again. */
  MEETING_BUSY: () =>
    new AppError("MEETING_BUSY", "The meeting is busy right now. Please try again.", 503),
  BUSY: () =>
    new AppError("BUSY", "This is busy with another change right now. Please try again.", 503),
  MEDIA_UNAVAILABLE: () =>
    new AppError(
      "MEDIA_UNAVAILABLE",
      "No meeting server is available right now. Please try again in a minute.",
      503,
    ),
  TEMPORARY_EMAIL: () =>
    new AppError("TEMPORARY_EMAIL", "Temporary email addresses are not allowed. Please use a personal or academic email.", 400),
} as const;

export function createValidationError(message: string): AppError {
  return Errors.VALIDATION(message);
}
