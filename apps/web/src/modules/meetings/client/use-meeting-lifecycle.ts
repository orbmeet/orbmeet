import * as React from "react";
import { useMaybeRoomContext } from "@livekit/components-react";
import type { Room } from "livekit-client";
import { stopAllLocalTracks, stopMediaElementsInScope } from "@/lib/media-cleanup";

interface MeetingLifecycleReturn {
  roomInstance: Room | undefined;
  /** Callback ref for the element that scopes the meeting's media elements. */
  mediaScope: (element: HTMLDivElement | null) => void;
  disconnectMeetingNow: () => Promise<void>;
}

/**
 * The meeting view's handle on the room, for leaving deliberately.
 *
 * Unmounting the view tears nothing down. The room belongs to
 * `MeetingConnection`, which disconnects it (and so stops the published
 * tracks) when it unmounts itself; the view can unmount without it, when
 * `MeetingViewBoundary` catches a crash or rebuilds the view, and the call
 * must go on through that.
 */
export function useMeetingLifecycle(): MeetingLifecycleReturn {
  const room = useMaybeRoomContext();
  const [disconnected, setDisconnected] = React.useState(false);
  const roomRef = React.useRef<Room | undefined>(room);
  const mediaScopeRef = React.useRef<HTMLDivElement | null>(null);

  React.useLayoutEffect(() => {
    roomRef.current = disconnected ? undefined : room;
  }, [disconnected, room]);

  const disconnectMeetingNow = React.useCallback(async () => {
    const activeRoom = roomRef.current;
    roomRef.current = undefined;
    setDisconnected(true);

    if (activeRoom) {
      await stopAllLocalTracks(activeRoom).catch(() => undefined);
      await activeRoom.disconnect(true).catch(() => undefined);
    }

    stopMediaElementsInScope(mediaScopeRef.current);
  }, []);

  const mediaScope = React.useCallback((element: HTMLDivElement | null) => {
    mediaScopeRef.current = element;
  }, []);

  return {
    roomInstance: disconnected ? undefined : room,
    mediaScope,
    disconnectMeetingNow,
  };
}
