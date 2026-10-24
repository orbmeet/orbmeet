import * as React from "react";
import {
  RoomContext,
  useSequentialRoomConnectDisconnect,
} from "@livekit/components-react";
import {
  MediaDeviceFailure,
  Room,
  RoomEvent,
  type DisconnectReason,
  type RoomConnectOptions,
  type RoomOptions,
} from "livekit-client";
import { emitMeetingEntryDiagnostic } from "@/modules/meetings/client/entry/diagnostics";
import { installMeetingMicrophoneSpeechHint } from "@/modules/meetings/client/audio/speech-content-hint";
import { useCommittedRef } from "@orbmeet/ui/react";

type InitialMediaParticipant = Pick<
  Room["localParticipant"],
  "setCameraEnabled" | "setMicrophoneEnabled"
>;

export async function publishInitialMeetingMedia(
  participant: InitialMediaParticipant,
  settings: {
    audioEnabled: boolean;
    audioDeviceId?: string;
    videoEnabled: boolean;
    videoDeviceId?: string;
  },
): Promise<InitialMeetingMediaResult> {
  // Capture constraints only belong on a track we are actually starting: a
  // muted / camera-off join must not pin a device onto a publish that never
  // happens. The pre-join choice still reaches RoomOptions capture defaults, so
  // the first in-meeting unmute uses the device the user picked.
  const [audio, video] = await Promise.allSettled([
    participant.setMicrophoneEnabled(
      settings.audioEnabled,
      settings.audioEnabled && settings.audioDeviceId
        ? { deviceId: settings.audioDeviceId }
        : undefined,
    ),
    participant.setCameraEnabled(
      settings.videoEnabled,
      settings.videoEnabled && settings.videoDeviceId
        ? { deviceId: settings.videoDeviceId }
        : undefined,
    ),
  ]);

  return {
    audioError: audio.status === "rejected" ? audio.reason : null,
    videoError: video.status === "rejected" ? video.reason : null,
  };
}

export interface InitialMeetingMediaResult {
  audioError: unknown | null;
  videoError: unknown | null;
}

interface MeetingConnectionProps {
  serverUrl: string;
  token: string;
  connectOptions?: RoomConnectOptions;
  options: RoomOptions;
  audioEnabled: boolean;
  audioDeviceId?: string;
  videoEnabled: boolean;
  videoDeviceId?: string;
  fallback: React.ReactNode;
  children: React.ReactNode;
  onConnected: () => void;
  /**
   * Fires once the initial microphone/camera publish — kicked off on
   * SignalConnected — has settled (resolved or rejected), which happens *after*
   * `onConnected` (RTC connected). The per-device result is recoverable state,
   * not a room-connection failure. Use this for teardown that must not race the
   * publish, e.g. stopping a pre-join warmup audio stream only once LiveKit has
   * taken ownership of the mic. This always fires so cleanup is never skipped.
   */
  onInitialMediaSettled: (result: InitialMeetingMediaResult) => void;
  onDisconnected: (reason?: DisconnectReason) => void;
  onError: (error: unknown) => void;
  onMediaDeviceFailure: (
    failure?: MediaDeviceFailure,
    kind?: MediaDeviceKind,
  ) => void;
}

/**
 * Owns one immutable LiveKit connection attempt.
 *
 * The meeting UI is intentionally not mounted until RoomEvent.Connected. This
 * keeps tldraw, captions, panels, and their effects out of the critical path
 * between receiving credentials and opening the LiveKit signaling socket.
 * A new connectionId/compatibility mode remounts this component with a fresh
 * LiveKit connection; token refreshes inside an established Meeting do not recreate it.
 */
export function MeetingConnection({
  serverUrl,
  token,
  connectOptions,
  options,
  audioEnabled,
  audioDeviceId,
  videoEnabled,
  videoDeviceId,
  fallback,
  children,
  onConnected,
  onInitialMediaSettled,
  onDisconnected,
  onError,
  onMediaDeviceFailure,
}: MeetingConnectionProps) {
  const [room] = React.useState(() => new Room(options));
  const [connection] = React.useState(() => ({
    serverUrl,
    token,
    connectOptions,
  }));
  const [initialMedia] = React.useState(() => ({
    audioEnabled,
    audioDeviceId,
    videoEnabled,
    videoDeviceId,
  }));
  const [connected, setConnected] = React.useState(false);
  const { connect, disconnect } = useSequentialRoomConnectDisconnect(room);

  const callbacksRef = useCommittedRef({
    onConnected,
    onInitialMediaSettled,
    onDisconnected,
    onError,
    onMediaDeviceFailure,
  });
  // The initial-media publish promise kicked off on SignalConnected. Connected
  // awaits it so warmup teardown (and any "media settled" bookkeeping) can't
  // race the publish — LiveKit must own the mic before the warmup stream stops.
  const initialMediaPromiseRef = React.useRef<Promise<InitialMeetingMediaResult> | null>(null);
  const reconnectStartedAtRef = React.useRef<number | null>(null);

  React.useEffect(() => {
    const disposeSpeechHint = installMeetingMicrophoneSpeechHint(room);

    const handleSignalConnected = () => {
      initialMediaPromiseRef.current = publishInitialMeetingMedia(
        room.localParticipant,
        initialMedia,
      );
    };
    const handleConnected = () => {
      setConnected(true);
      callbacksRef.current.onConnected();
      // Wait for the initial mic/camera publish to settle before signalling
      // media-settled. If SignalConnected never fired (e.g. a fast connect),
      // there is no publish to wait on — settle immediately.
      const pending = initialMediaPromiseRef.current;
      if (pending) {
        void pending.then((result) => callbacksRef.current.onInitialMediaSettled(result));
      } else {
        callbacksRef.current.onInitialMediaSettled({ audioError: null, videoError: null });
      }
    };
    const handleDisconnected = (reason?: DisconnectReason) => {
      setConnected(false);
      emitMeetingEntryDiagnostic("livekit_disconnected", {
        reason: reason === undefined ? "unknown" : String(reason),
        reconnectDurationMs: reconnectStartedAtRef.current === null
          ? undefined
          : Math.round(performance.now() - reconnectStartedAtRef.current),
      });
      reconnectStartedAtRef.current = null;
      callbacksRef.current.onDisconnected(reason);
    };
    const handleReconnecting = () => {
      if (reconnectStartedAtRef.current !== null) return;
      reconnectStartedAtRef.current = performance.now();
      emitMeetingEntryDiagnostic("livekit_reconnecting");
    };
    const handleReconnected = () => {
      const startedAt = reconnectStartedAtRef.current;
      reconnectStartedAtRef.current = null;
      emitMeetingEntryDiagnostic("livekit_reconnected", {
        reconnectDurationMs: startedAt === null
          ? undefined
          : Math.round(performance.now() - startedAt),
      });
    };
    const handleMediaDeviceError = (error: Error, kind?: MediaDeviceKind) => {
      callbacksRef.current.onMediaDeviceFailure(
        MediaDeviceFailure.getFailure(error),
        kind,
      );
    };

    room
      .on(RoomEvent.SignalConnected, handleSignalConnected)
      .on(RoomEvent.Connected, handleConnected)
      .on(RoomEvent.Reconnecting, handleReconnecting)
      .on(RoomEvent.Reconnected, handleReconnected)
      .on(RoomEvent.Disconnected, handleDisconnected)
      .on(RoomEvent.MediaDevicesError, handleMediaDeviceError);

    return () => {
      disposeSpeechHint();
      room
        .off(RoomEvent.SignalConnected, handleSignalConnected)
        .off(RoomEvent.Connected, handleConnected)
        .off(RoomEvent.Reconnecting, handleReconnecting)
        .off(RoomEvent.Reconnected, handleReconnected)
        .off(RoomEvent.Disconnected, handleDisconnected)
        .off(RoomEvent.MediaDevicesError, handleMediaDeviceError);
    };
  }, [callbacksRef, initialMedia, room]);

  // A phone that locks or backgrounds the browser can suspend the page, and
  // with it everything the connection would report; record that it happened.
  React.useEffect(() => {
    let hiddenAt: number | null = null;
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        hiddenAt = performance.now();
        emitMeetingEntryDiagnostic("page_hidden", { connectionState: room.state });
        return;
      }
      emitMeetingEntryDiagnostic("page_visible", {
        connectionState: room.state,
        hiddenForMs: hiddenAt === null ? undefined : Math.round(performance.now() - hiddenAt),
      });
      hiddenAt = null;
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [room]);

  React.useEffect(() => {
    let active = true;

    void connect(
      connection.serverUrl,
      connection.token,
      connection.connectOptions,
    ).catch((error) => {
      if (active) callbacksRef.current.onError(error);
    });

    return () => {
      active = false;
      void disconnect();
    };
  }, [callbacksRef, connect, connection, disconnect]);

  return (
    // The old `lk-room-container` class matched no rule in any stylesheet this
    // app ships (LiveKit's own styles are not imported), so it is dropped
    // rather than carried over as a dead class.
    <div>
      <RoomContext.Provider value={room}>
        {connected ? children : fallback}
      </RoomContext.Provider>
    </div>
  );
}
