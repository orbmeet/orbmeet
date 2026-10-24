import * as React from "react";
import { RoomEvent } from "livekit-client";
import { useRoomContext } from "@livekit/components-react";
import { PlaybackUnlock, type PlaybackUnlockPort } from "./playback-unlock";
import { onNextUserGesture } from "./user-gesture";
import { applyAudioSessionType, describeAudioPolicy } from "./audio-policy";
import { getActiveAudioPolicy } from "./audio-policy-context";
import { getPlatformEnvironment } from "@/lib/browser-capabilities";
import { emitMeetingEntryDiagnostic } from "@/modules/meetings/client/entry/diagnostics";

export interface AudioPlaybackUnlockState {
  /** True when the browser is refusing to play meeting audio. */
  blocked: boolean;
  /** Retry from inside a click handler. */
  unlock: () => void;
}

export function useAudioPlaybackUnlock(): AudioPlaybackUnlockState {
  const room = useRoomContext();
  const controllerRef = React.useRef<PlaybackUnlock | null>(null);
  const snapshotListenersRef = React.useRef(new Set<() => void>());

  const notifySnapshotChanged = React.useCallback(() => {
    for (const listener of snapshotListenersRef.current) listener();
  }, []);

  const subscribe = React.useCallback(
    (listener: () => void) => {
      snapshotListenersRef.current.add(listener);
      room?.on(RoomEvent.AudioPlaybackStatusChanged, listener);
      return () => {
        snapshotListenersRef.current.delete(listener);
        room?.off(RoomEvent.AudioPlaybackStatusChanged, listener);
      };
    },
    [room],
  );
  const getSnapshot = React.useCallback(
    () => room ? !room.canPlaybackAudio : false,
    [room],
  );
  const blocked = React.useSyncExternalStore(subscribe, getSnapshot, () => false);

  // Routing and playback permission are the same OS-level concern, so the
  // session type is declared here rather than in a hook of its own. Recording
  // the outcome matters: whether WebKit accepted the type is invisible from
  // outside the device, and it is the first thing to check when someone
  // reports that everyone sounds quiet.
  React.useEffect(() => {
    const policy = getActiveAudioPolicy();
    const outcome = applyAudioSessionType(policy.audioSessionType);
    emitMeetingEntryDiagnostic("audio_policy_resolved", {
      ...describeAudioPolicy(getPlatformEnvironment(), policy),
      audioSessionOutcome: outcome,
    });
  }, []);

  React.useEffect(() => {
    if (!room) return;

    const port: PlaybackUnlockPort = {
      canPlayAudio: () => room.canPlaybackAudio,
      startAudio: () => room.startAudio(),
      onNextUserGesture,
    };

    const unlock = new PlaybackUnlock(port, {
      onStateChange: notifySnapshotChanged,
      onDiagnostic: (event, data) => {
        emitMeetingEntryDiagnostic(
          event === "unlocked" ? "audio_playback_unlocked" : "audio_playback_blocked",
          {
            trigger: data.trigger,
            attempts: data.attempts,
            errorName: data.error instanceof Error ? data.error.name : undefined,
          },
        );
      },
    });

    // LiveKit can revoke playback later — a new remote track whose `play()` is
    // refused flips the room back to blocked long after join.
    const handlePlaybackChanged = () => {
      if (!room.canPlaybackAudio) unlock.start();
    };
    room.on(RoomEvent.AudioPlaybackStatusChanged, handlePlaybackChanged);

    controllerRef.current = unlock;
    unlock.start();

    return () => {
      room.off(RoomEvent.AudioPlaybackStatusChanged, handlePlaybackChanged);
      unlock.dispose();
      if (controllerRef.current === unlock) controllerRef.current = null;
    };
  }, [notifySnapshotChanged, room]);

  const unlock = React.useCallback(() => {
    controllerRef.current?.unlockFromUserGesture();
  }, []);

  return React.useMemo(() => ({ blocked, unlock }), [blocked, unlock]);
}
