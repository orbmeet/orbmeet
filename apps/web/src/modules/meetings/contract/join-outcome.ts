/**
 * Which join refusals are worth repeating.
 *
 * A join answers in one of two ways: a refusal that states a fact about the
 * participant or the meeting (denied, full, ended, closed, signed out), or one
 * that describes a condition expected to clear on its own. Only the second
 * kind is retryable, and the server decides which is which — the client never
 * infers it from an HTTP status.
 *
 * - `CONFLICT`: another request holds this participant's connection, the
 *   connection rows moved under a bounded number of compare-and-set attempts,
 *   or the link's previous meeting has ended but is not yet finalized.
 * - `MEETING_CONNECTION_CLOSED`: a webhook or sweep ended the connection a
 *   reconnect was re-issuing; the next attempt starts from the new row state.
 * - `MEDIA_UNAVAILABLE`: no healthy media node yet — typically the node this
 *   participant just lost, before health checks move the meeting.
 * - `RATE_LIMITED`: per-IP throttling; retry, but slowly.
 * - `INTERNAL_ERROR`: an unexpected failure, surfaced without detail.
 */
const RETRYABLE_JOIN_CODES: ReadonlySet<string> = new Set([
  "CONFLICT",
  "MEETING_CONNECTION_CLOSED",
  "MEDIA_UNAVAILABLE",
  "RATE_LIMITED",
  "INTERNAL_ERROR",
]);

export function isRetryableJoinCode(code: string | null | undefined): boolean {
  return code != null && RETRYABLE_JOIN_CODES.has(code);
}
