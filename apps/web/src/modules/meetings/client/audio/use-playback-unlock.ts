import * as React from "react";
import { RoomEvent, type Room } from "livekit-client";
import { useRoomContext } from "@livekit/components-react";
import { PlaybackUnlock, type PlaybackUnlockPort } from "./playback-unlock";
import { onNextUserGesture } from "./user-gesture";
import { applyAudioSessionType, describeAudioPolicy } from "./audio-policy";
import { getActiveAudioPolicy } from "./audio-policy-context";
import { getPlatformEnvironment } from "@/lib/browser-capabilities";
import { emitMeetingEntryDiagnostic } from "@/modules/meetings/client/entry/diagnostics";

/** What the browser is refusing to play, audio first: it is what a call cannot do without. */
type BlockedPlayback = "audio" | "video" | null;

export interface PlaybackUnlockState {
  blocked: BlockedPlayback;
  /** Retry from inside a click handler. */
  unlock: () => void;
}

function blockedPlayback(room: Room): BlockedPlayback {
  if (!room.canPlaybackAudio) return "audio";
  if (!room.canPlaybackVideo) return "video";
  return null;
}

const PLAYBACK_EVENTS = [RoomEvent.AudioPlaybackStatusChanged, RoomEvent.VideoPlaybackStatusChanged] as const;

export function usePlaybackUnlock(): PlaybackUnlockState {
  const room = useRoomContext();
  const controllerRef = React.useRef<PlaybackUnlock | null>(null);
  const snapshotListenersRef = React.useRef(new Set<() => void>());

  const notifySnapshotChanged = React.useCallback(() => {
    for (const listener of snapshotListenersRef.current) listener();
  }, []);

  const subscribe = React.useCallback(
    (listener: () => void) => {
      snapshotListenersRef.current.add(listener);
      for (const event of PLAYBACK_EVENTS) room?.on(event, listener);
      return () => {
        snapshotListenersRef.current.delete(listener);
        for (const event of PLAYBACK_EVENTS) room?.off(event, listener);
      };
    },
    [room],
  );
  const getSnapshot = React.useCallback(() => (room ? blockedPlayback(room) : null), [room]);
  const blocked = React.useSyncExternalStore(subscribe, getSnapshot, () => null);

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
      canPlay: () => blockedPlayback(room) === null,
      // Both `play()`s are issued now, inside the gesture; neither may cut the
      // other's wait short.
      play: async () => {
        await Promise.allSettled([room.startAudio(), room.startVideo()]);
      },
      onNextUserGesture,
    };

    const unlock = new PlaybackUnlock(port, {
      onStateChange: notifySnapshotChanged,
      onDiagnostic: (event, data) => {
        emitMeetingEntryDiagnostic(
          event === "unlocked" ? "playback_unlocked" : "playback_blocked",
          {
            trigger: data.trigger,
            blocked: blockedPlayback(room) ?? undefined,
            attempts: data.attempts,
            errorName: data.error instanceof Error ? data.error.name : undefined,
          },
        );
      },
    });

    // LiveKit can revoke playback later — a new remote track whose `play()` is
    // refused flips the room back to blocked long after join.
    const handlePlaybackChanged = () => {
      if (blockedPlayback(room)) unlock.start();
    };
    for (const event of PLAYBACK_EVENTS) room.on(event, handlePlaybackChanged);

    controllerRef.current = unlock;
    unlock.start();

    return () => {
      for (const event of PLAYBACK_EVENTS) room.off(event, handlePlaybackChanged);
      unlock.dispose();
      if (controllerRef.current === unlock) controllerRef.current = null;
    };
  }, [notifySnapshotChanged, room]);

  const unlock = React.useCallback(() => {
    controllerRef.current?.unlockFromUserGesture();
  }, []);

  return React.useMemo(() => ({ blocked, unlock }), [blocked, unlock]);
}
