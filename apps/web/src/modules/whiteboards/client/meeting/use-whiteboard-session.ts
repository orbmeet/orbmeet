import * as React from "react";
import type { Room } from "livekit-client";
import { logError, logWarn } from "@/lib/logger";
import { deviceTimeZone } from "@/lib/time-zone";
import { markMeetingWhiteboardRequested } from "@/modules/meetings/client/entry-metrics";
import { useMeetingRoomState } from "@/modules/meetings/client/use-meeting-live-state";
import type { JoinResult } from "@/modules/meetings/contract/types";
import { preloadMeetingWhiteboardModule } from "@/modules/whiteboards/client/meeting/preload-whiteboard";
import {
  WhiteboardSession,
  type WhiteboardSessionSnapshot,
} from "@/modules/whiteboards/client/meeting/whiteboard-session";
import {
  getWhiteboardToken,
  setWhiteboardSurfaceState,
} from "@/modules/whiteboards/server/meeting-actions.functions";

function createSession(joinResult: JoinResult, canModerate: boolean): WhiteboardSession {
  const { meetingId, connectionId } = joinResult;
  return new WhiteboardSession({
    connectionId,
    surface: joinResult.surface,
    canModerate,
    // A Space meeting is about the work the Space keeps, so it opens on the
    // board. A personal-link call opens on faces, with the board one tap away.
    openOnStart: Boolean(joinResult.spaceName),
    api: {
      mintAccess: () => getWhiteboardToken({ data: { meetingId, connectionId } }),
      // The device zone rides along so an untitled first board is named after
      // the day the people in the Meeting are having, not the Worker's UTC
      // day. The server treats it as a hint and never stores it.
      writeSurface: (open) =>
        setWhiteboardSurfaceState({
          data: { meetingId, connectionId, open, clientTimeZone: deviceTimeZone() },
        }),
    },
    onOpening: () => {
      // Anchoring `whiteboard_open_ms` to the moment the spinner appears keeps
      // the measurement honest about what the user waited for.
      markMeetingWhiteboardRequested();
      preloadMeetingWhiteboardModule().catch(() => {});
    },
    logError,
    logWarn,
  });
}

/**
 * The meeting's whiteboard session: one per meeting connection. A new
 * connection gets a new session instead of resetting the old one.
 */
export function useWhiteboardSession(
  joinResult: JoinResult,
  room: Room | undefined,
  canModerate = joinResult.canModerate,
): { session: WhiteboardSession; state: WhiteboardSessionSnapshot } {
  // Created for the connection it serves; later props reach it through the
  // setters below. A new connection replaces it during render, React's
  // pattern for state derived from a changed prop.
  const key = `${joinResult.meetingId}:${joinResult.connectionId}`;
  const [current, setCurrent] = React.useState(() => ({ key, session: createSession(joinResult, canModerate) }));
  let session = current.session;
  if (current.key !== key) {
    session = createSession(joinResult, canModerate);
    setCurrent({ key, session });
  }

  React.useEffect(() => {
    session.activate();
    return () => session.deactivate();
  }, [session]);
  React.useEffect(() => session.setRoom(room), [session, room]);
  React.useEffect(() => session.setCanModerate(canModerate), [session, canModerate]);
  // The room's surface reaches every participant in room metadata.
  const surface = useMeetingRoomState(room)?.surface ?? null;
  React.useEffect(() => session.setSurface(surface), [session, surface]);

  const state = React.useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  return { session, state };
}
