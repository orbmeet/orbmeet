import * as React from "react";
import type { Room } from "livekit-client";
import { useNow } from "@/lib/hooks/use-now";
import { logError } from "@/lib/logger";
import type { MeetingRoomState } from "@/modules/meetings/contract/live-state";
import { setCountdown } from "@/modules/meetings/server/runtime/live.functions";
import type { MeetingClockSync } from "./meeting-clock";
import { useMeetingRoomState } from "./use-meeting-live-state";

/** The longest countdown a moderator can start. */
const MAX_COUNTDOWN_MINUTES = 999;

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
  roomState: providedRoomState,
  meetingId,
  connectionId,
  canControl,
  meetingClock,
}: {
  room: Room | undefined;
  roomState?: MeetingRoomState | null;
  meetingId: string;
  connectionId: string;
  canControl: boolean;
  meetingClock: MeetingClockSync;
}): SharedCountdownState {
  const roomState = useMeetingRoomState(room, providedRoomState);
  const endsAtMs = roomState?.countdown.endsAt ?? null;
  const offsetMs = meetingClock.serverClockOffsetMs;
  const now = useNow(500, endsAtMs !== null);
  const remainingSeconds =
    endsAtMs === null ? 0 : Math.max(0, Math.ceil((endsAtMs - (now + offsetMs)) / 1_000));

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
