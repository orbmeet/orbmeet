/**
 * Translating the server's meeting start into a ticking client clock.
 *
 * The correctness rule this module exists to enforce: a server instant may only
 * ever be differenced against the client instant that was current *when that
 * server instant arrived*. Pairing a fixed `serverNowMs` from an old response
 * with a fresh `Date.now()` yields an "offset" that is really just the age of
 * the response, and subtracts it from every subsequent reading.
 *
 * Computing the offset inside the component that renders the timer would
 * recompute it on every remount — and a second participant joining remounts
 * the meeting header, so the host's timer would silently fall minutes behind
 * the guest's. That matters beyond cosmetics because plan duration limits are
 * enforced against the real elapsed time, not the displayed one.
 *
 * So the reconciled offset is the thing that travels, not the raw pair.
 */

/** The server's view of the meeting, already reconciled against the local clock. */
export interface MeetingClockSync {
  meetingStartedAtMs: number;
  /**
   * `serverNowMs - clientNowMs`, sampled at the instant the server response was
   * received. Computed once per response, above any component that can remount.
   */
  serverClockOffsetMs: number;
}

/** The raw pair as it comes off a join or refresh response. */
export interface MeetingClockReading {
  meetingStartedAtMs: number;
  serverNowMs: number;
}

/**
 * @param clientNowMs `Date.now()` sampled as close as possible to the moment
 *   `serverNowMs` was received. Passing a later sample is the bug this module
 *   is written to prevent.
 */
export function getServerClockOffsetMs(serverNowMs: number, clientNowMs: number): number {
  if (!Number.isFinite(serverNowMs) || !Number.isFinite(clientNowMs)) return 0;
  return serverNowMs - clientNowMs;
}

export function getMeetingElapsedSeconds(
  clock: Pick<MeetingClockSync, "meetingStartedAtMs">,
  serverClockOffsetMs: number,
  clientNowMs: number,
): number {
  if (
    !Number.isFinite(clock.meetingStartedAtMs) ||
    !Number.isFinite(serverClockOffsetMs) ||
    !Number.isFinite(clientNowMs)
  ) {
    return 0;
  }
  return Math.max(0, Math.floor((clientNowMs + serverClockOffsetMs - clock.meetingStartedAtMs) / 1000));
}
