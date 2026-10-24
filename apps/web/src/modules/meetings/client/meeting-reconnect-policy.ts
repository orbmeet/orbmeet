import type { ReconnectContext, ReconnectPolicy } from "livekit-client";

// Long enough for an ordinary Wi-Fi/mobile handoff to resume in place, short
// enough that a dead media node does not hold the client: after this, the
// application's own rejoin asks the Worker, which can move the Meeting to
// another node (entry/meeting-entry-session.ts, AUTO_REJOIN_DELAYS_MS).
export const MAX_MEETING_RECONNECT_ELAPSED_MS = 20 * 1000;
const MAX_RECONNECT_DELAY_MS = 4_000;

/**
 * Keep a room alive through ordinary mobile handoffs. LiveKit owns reconnect
 * timing only briefly; the application performs a fresh authenticated join
 * after this policy is exhausted, and keeps trying for longer outages.
 */
export class MeetingReconnectPolicy implements ReconnectPolicy {
  nextRetryDelayInMs(context: ReconnectContext): number | null {
    if (context.elapsedMs >= MAX_MEETING_RECONNECT_ELAPSED_MS) return null;
    if (context.retryCount <= 1) return 0;

    const exponential = Math.min(
      MAX_RECONNECT_DELAY_MS,
      500 * 2 ** Math.min(context.retryCount - 2, 5),
    );
    const jitter = Math.floor(Math.random() * 500);
    return exponential + jitter;
  }
}
