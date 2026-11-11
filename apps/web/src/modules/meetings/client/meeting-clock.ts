/**
 * The server's clock, as this browser can read it.
 *
 * A server instant may only be differenced against the client instant that
 * was current when it arrived. Pairing a `serverNowMs` with a later
 * `Date.now()` makes the response's age part of the offset, and every reading
 * after is off by it. So the clock is built once, by the entry session, when
 * the join response is accepted (`MeetingEntrySession`), and handed down;
 * nothing that can mount later — the meeting view after its connection comes
 * up, or again after "Reload view" — ever pairs the two itself.
 */

export interface MeetingClockSync {
  meetingStartedAtMs: number;
  /** Server time minus this browser's time, taken when the join response arrived. */
  serverClockOffsetMs: number;
}

/** The clock a join response gives, received at `receivedAtMs` on this browser's clock. */
export function meetingClockFrom(
  response: { meetingStartedAtMs: number; serverNowMs: number },
  receivedAtMs: number,
): MeetingClockSync {
  const offset = response.serverNowMs - receivedAtMs;
  return {
    meetingStartedAtMs: response.meetingStartedAtMs,
    serverClockOffsetMs: Number.isFinite(offset) ? offset : 0,
  };
}

/** A server-stamped instant, on this browser's clock. */
export function toLocalTime(clock: MeetingClockSync, serverMs: number): number {
  return serverMs - clock.serverClockOffsetMs;
}

export function getMeetingElapsedSeconds(clock: MeetingClockSync, clientNowMs: number): number {
  const elapsedMs = clientNowMs + clock.serverClockOffsetMs - clock.meetingStartedAtMs;
  return Number.isFinite(elapsedMs) ? Math.max(0, Math.floor(elapsedMs / 1000)) : 0;
}
