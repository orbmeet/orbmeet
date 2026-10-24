import { useEffect, useState } from "react";
import {
  getMeetingElapsedSeconds,
  getServerClockOffsetMs,
  type MeetingClockReading,
  type MeetingClockSync,
} from "@/modules/meetings/client/meeting-clock";

/**
 * Reconcile a join/refresh response against the local clock, once per response.
 *
 * Call this from the hook that owns the join result — somewhere stable — and
 * pass the resulting `MeetingClockSync` down. It must not live in a component
 * that remounts: the whole point is that `Date.now()` is sampled when
 * `serverNowMs` arrives and never re-sampled against that same server instant.
 */
/* oxlint-disable react/purity -- the clock read is the deliberate purpose of this hook. */
export function useMeetingClockSync(reading: MeetingClockReading): MeetingClockSync {
  "use no memo";
  const { meetingStartedAtMs, serverNowMs } = reading;

  // React's "adjust state when a prop changes" pattern rather than a memo: the
  // sample must happen exactly when a new `serverNowMs` arrives. A `useMemo`
  // re-runs whenever React feels like it and would re-pair the same server
  // instant with a later `Date.now()`, which is the drift this module exists to
  // prevent.
  const [sync, setSync] = useState(() => ({
    serverNowMs,
    offsetMs: getServerClockOffsetMs(serverNowMs, Date.now()),
  }));
  if (sync.serverNowMs !== serverNowMs) {
    setSync({ serverNowMs, offsetMs: getServerClockOffsetMs(serverNowMs, Date.now()) });
  }

  return { meetingStartedAtMs, serverClockOffsetMs: sync.offsetMs };
}

export function useMeetingElapsedSeconds(clock: MeetingClockSync): number {
  "use no memo";
  // This hook intentionally samples wall-clock time to translate a server
  // timestamp into a client-side ticking clock. The offset arrives already
  // reconciled, so a remount here cannot shift the anchor.
  const { meetingStartedAtMs, serverClockOffsetMs } = clock;
  const [elapsed, setElapsed] = useState(() =>
    getMeetingElapsedSeconds({ meetingStartedAtMs }, serverClockOffsetMs, Date.now()),
  );

  useEffect(() => {
    const update = () => {
      setElapsed(getMeetingElapsedSeconds({ meetingStartedAtMs }, serverClockOffsetMs, Date.now()));
    };
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [meetingStartedAtMs, serverClockOffsetMs]);

  return elapsed;
}
/* oxlint-enable react/purity */
