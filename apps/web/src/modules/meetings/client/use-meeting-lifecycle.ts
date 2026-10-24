import * as React from "react";
import type { Room } from "livekit-client";
import {
  stopAllLocalTracks,
  stopAllLocalTracksSync,
  stopMediaElementsInScope,
} from "@/lib/media-cleanup";

interface MeetingLifecycleReturn {
  roomInstance: Room | undefined;
  /** Callback ref for the element that scopes the meeting's media elements. */
  mediaScope: (element: HTMLDivElement | null) => void;
  handleLiveKitRoomUpdate: (room: Room | undefined) => void;
  disconnectMeetingNow: () => Promise<void>;
}

export function useMeetingLifecycle(): MeetingLifecycleReturn {
  const roomRef = React.useRef<Room | undefined>(undefined);
  const [roomInstance, setRoomInstance] = React.useState<Room | undefined>(undefined);
  const mediaScopeRef = React.useRef<HTMLDivElement | null>(null);
  const deferredCleanupRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

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

  const scheduleDeferredCleanup = React.useCallback(() => {
    // Defer cleanup by one tick so React DEV strict-mode's simulated unmount
    // doesn't tear down an in-flight initial connection. This callback reads
    // the live refs when teardown runs, rather than an effect-setup snapshot.
    const mediaScope = mediaScopeRef.current;
    deferredCleanupRef.current = setTimeout(() => {
      deferredCleanupRef.current = null;
      if (roomRef.current) {
        stopAllLocalTracksSync(roomRef.current);
        roomRef.current.disconnect(true).catch(() => {});
      }
      stopMediaElementsInScope(mediaScope);
    }, 0);
  }, []);

  // Cleanup on unmount.
  React.useEffect(() => {
    if (deferredCleanupRef.current) {
      clearTimeout(deferredCleanupRef.current);
      deferredCleanupRef.current = null;
    }

    return scheduleDeferredCleanup;
  }, [scheduleDeferredCleanup]);

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
