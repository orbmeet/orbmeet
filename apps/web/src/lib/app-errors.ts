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
