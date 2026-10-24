import * as React from "react";
import type { Room } from "livekit-client";
import { logError } from "@/lib/logger";
import { setCountdown } from "@/modules/meetings/server/runtime/live.functions";
import type { MeetingClockSync } from "./meeting-clock";
import { MAX_COUNTDOWN_MINUTES } from "./shared-countdown";
import { useMeetingRoomState } from "./use-meeting-live-state";

export interface SharedCountdownState {
  endsAtMs: number | null;
  remainingSeconds: number;
  active: boolean;
  done: boolean;
  canControl: boolean;
  start: (minutes: number) => boolean;
  stop: () => boolean;
}

/**
 * The meeting's countdown, kept by its coordinator in room metadata. Its end
 * is in the server's clock, which `meetingClock` reconciles this client to.
 */
export function useSharedCountdown({
  room,
  meetingId,
  connectionId,
  canControl,
  meetingClock,
}: {
  room: Room | undefined;
  meetingId: string;
  connectionId: string;
  canControl: boolean;
  meetingClock: MeetingClockSync;
}): SharedCountdownState {
  const roomState = useMeetingRoomState(room);
  const endsAtMs = roomState?.countdown.endsAt ?? null;
  const offsetMs = meetingClock.serverClockOffsetMs;
  const remaining = React.useCallback(
    () => (endsAtMs === null ? 0 : Math.max(0, Math.ceil((endsAtMs - (Date.now() + offsetMs)) / 1_000))),
    [endsAtMs, offsetMs],
  );
  const [remainingSeconds, setRemainingSeconds] = React.useState(remaining);

  React.useEffect(() => {
    setRemainingSeconds(remaining());
    if (endsAtMs === null) return;
    const timer = window.setInterval(() => setRemainingSeconds(remaining()), 500);
    return () => window.clearInterval(timer);
  }, [endsAtMs, remaining]);

  const send = React.useCallback((endsAt: number | null) => {
    if (!canControl) return false;
    setCountdown({ data: { meetingId, connectionId, endsAtMs: endsAt } }).catch((error: unknown) => {
      logError("[Meeting] Countdown update failed:", error);
    });
    return true;
  }, [canControl, connectionId, meetingId]);

  return {
    endsAtMs,
    remainingSeconds,
    active: endsAtMs !== null && remainingSeconds > 0,
    done: endsAtMs !== null && remainingSeconds === 0,
    canControl,
    start: React.useCallback((minutes: number) => {
      if (!Number.isFinite(minutes) || minutes <= 0 || minutes > MAX_COUNTDOWN_MINUTES) return false;
      return send(Date.now() + offsetMs + Math.round(minutes * 60_000));
    }, [offsetMs, send]),
    stop: React.useCallback(() => send(null), [send]),
  };
}
