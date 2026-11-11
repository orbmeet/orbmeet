import * as React from "react";
import type { Room } from "livekit-client";
import { stopAllLocalTracks, stopMediaElementsInScope } from "@/lib/media-cleanup";

interface MeetingLifecycleReturn {
  roomInstance: Room | undefined;
  /** Callback ref for the element that scopes the meeting's media elements. */
  mediaScope: (element: HTMLDivElement | null) => void;
  handleLiveKitRoomUpdate: (room: Room | undefined) => void;
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
  const roomRef = React.useRef<Room | undefined>(undefined);
  const [roomInstance, setRoomInstance] = React.useState<Room | undefined>(undefined);
  const mediaScopeRef = React.useRef<HTMLDivElement | null>(null);

  // Sync room context from LiveKitRoom to parent refs
  const handleLiveKitRoomUpdate = React.useCallback((room: Room | undefined) => {
    roomRef.current = room;
    setRoomInstance(room);
  }, []);

  const disconnectMeetingNow = React.useCallback(async () => {
    const room = roomRef.current;
    roomRef.current = undefined;
    setRoomInstance(undefined);

    if (room) {
      await stopAllLocalTracks(room).catch(() => undefined);
      await room.disconnect(true).catch(() => undefined);
    }

    stopMediaElementsInScope(mediaScopeRef.current);
  }, []);

  const mediaScope = React.useCallback((element: HTMLDivElement | null) => {
    mediaScopeRef.current = element;
  }, []);

  return {
    roomInstance,
    mediaScope,
    handleLiveKitRoomUpdate,
    disconnectMeetingNow,
  };
}
