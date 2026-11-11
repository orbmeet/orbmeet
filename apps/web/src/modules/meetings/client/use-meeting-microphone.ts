import * as React from "react";
import {
  ConnectionState,
  MediaDeviceFailure,
  RoomEvent,
  Track,
  type LocalAudioTrack,
  type Participant,
  type Room,
  type TrackPublication,
} from "livekit-client";
import type { useToast } from "@orbmeet/ui/react";
import { logWarn } from "@/lib/logger";
import { getLocalMicrophoneRecoverySnapshot } from "@/modules/meetings/client/microphone-recovery";
import {
  MicrophoneController,
  type MicrophoneFailure,
} from "@/modules/meetings/client/audio/microphone-controller";
import {
  MicrophoneInterruption,
  type AudioSessionState,
} from "@/modules/meetings/client/audio/microphone-interruption";
import { onNextUserGesture } from "@/modules/meetings/client/audio/user-gesture";
import { emitMeetingEntryDiagnostic } from "@/modules/meetings/client/entry/diagnostics";
import { useCommittedRef } from "@orbmeet/ui/react";
import { watchLocalDeviceLoss } from "@/modules/meetings/client/local-device-loss";
import {
  InitialMeetingMediaContext,
  type InitialMeetingMediaResult,
} from "@/modules/meetings/client/initial-meeting-media";

interface UseMeetingMicrophoneParams {
  roomInstance: Room | undefined;
  code: string;
  addToast: ReturnType<typeof useToast>["add"];
  /**
   * The participant chose to mute or unmute. Only explicit choices are
   * reported: a mute the controller adopts from LiveKit also happens when a
   * connection is torn down, and must not decide how the next one starts.
   */
  onChoice?: (choice: { audioEnabled: boolean }) => void;
}

function errorName(error: unknown): string | undefined {
  return error instanceof Error ? error.name : undefined;
}

function errorMessage(error: unknown): string | undefined {
  return error instanceof Error ? error.message : undefined;
}

function getDeviceFailure(error: Error): MediaDeviceFailure | undefined {
  return MediaDeviceFailure.getFailure(error);
}

/** WebKit's Audio Session API: where the platform's interruptions show. */
interface AudioSessionLike extends EventTarget {
  state?: string;
}

function getAudioSession(): AudioSessionLike | null {
  if (typeof navigator === "undefined") return null;
  return (navigator as Navigator & { audioSession?: AudioSessionLike }).audioSession ?? null;
}

function readAudioSessionState(): AudioSessionState | null {
  const state = getAudioSession()?.state;
  return state === "active" || state === "inactive" || state === "interrupted" ? state : null;
}

function isPageVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState === "visible";
}

const FAILURE_TOASTS: Record<
  MicrophoneFailure,
  { title: string; fallback: string }
> = {
  enable: {
    title: "Could not unmute",
    fallback: "The microphone state could not be updated.",
  },
  disable: {
    title: "Could not mute",
    fallback: "The microphone state could not be updated.",
  },
  heal: {
    title: "Microphone didn't start cleanly",
    fallback:
      "Your mic unmuted but its audio track wasn't healthy. Try unmuting again or rejoin the meeting.",
  },
};

/**
 * Each join's initial publish is reported once, even when the view that
 * reports it is rebuilt.
 */
const reportedInitialMedia = new WeakSet<Promise<InitialMeetingMediaResult>>();

/** Surfaces a failed first microphone. Returns a cleanup for a pending retry. */
function reportInitialMicrophoneFailure(
  error: Error,
  controller: MicrophoneController,
  callbacks: Pick<UseMeetingMicrophoneParams, "addToast" | "code">,
): () => void {
  const failure = getDeviceFailure(error);
  emitMeetingEntryDiagnostic("initial_microphone_publish_failed", {
    code: callbacks.code,
    failure,
    errorName: error.name,
    errorMessage: error.message,
    pageVisible: isPageVisible(),
  });

  // A browser refuses capture to a page that is not showing: Chrome on
  // Android denies a backgrounded tab, and that is exactly when an automatic
  // rejoin runs. The joiner asked for their microphone, so ask once more
  // when the page shows; a refusal that stands then surfaces as the
  // controller's own unmute failure.
  if (failure === MediaDeviceFailure.PermissionDenied) {
    const retry = () => {
      emitMeetingEntryDiagnostic("initial_microphone_retry", { code: callbacks.code });
      controller.setIntent("on");
    };
    if (isPageVisible()) {
      retry();
      return () => {};
    }
    const handleVisible = () => {
      if (!isPageVisible()) return;
      document.removeEventListener("visibilitychange", handleVisible);
      retry();
    };
    document.addEventListener("visibilitychange", handleVisible);
    return () => document.removeEventListener("visibilitychange", handleVisible);
  }

  callbacks.addToast({
    title: "Joined with microphone off",
    description:
      "The selected microphone could not start. Choose another microphone, then unmute.",
    data: { variant: "error" },
  });
  return () => {};
}

/**
 * Binds the microphone controller to React and to LiveKit's events.
 *
 * The hook holds no microphone state of its own: `MicrophoneController` owns
 * intent, and everything here is either an event feeding into it or a
 * projection coming out of it.
 */
export function useMeetingMicrophone({
  roomInstance,
  code,
  addToast,
  onChoice,
}: UseMeetingMicrophoneParams) {
  const [, bumpRenderVersion] = React.useReducer((version: number) => version + 1, 0);
  const [controller, setController] = React.useState<MicrophoneController | null>(null);
  const [interruption, setInterruption] = React.useState<MicrophoneInterruption | null>(null);
  const initialMedia = React.useContext(InitialMeetingMediaContext);

  const callbacksRef = useCommittedRef({ addToast, code, onChoice });

  React.useEffect(() => {
    if (!roomInstance) {
      setController(null);
      return;
    }

    const participant = roomInstance.localParticipant;
    const next = new MicrophoneController(
      participant,
      // Seed from what the join actually published: someone who joined muted,
      // or whose initial publish failed, starts muted by intent too.
      participant.isMicrophoneEnabled ? "on" : "off",
      {
        onStateChange: bumpRenderVersion,
        onRecoveryAttempt: (snapshot) => {
          emitMeetingEntryDiagnostic("local_mic_unmute_recovery", {
            code: callbacksRef.current.code,
            ...snapshot,
          });
        },
        onRecoveryResult: (result) => {
          // "ok": the check after an unmute found nothing to repair.
          if (result === "ok") return;
          emitMeetingEntryDiagnostic("local_mic_recovery_result", {
            code: callbacksRef.current.code,
            result,
            ...getLocalMicrophoneRecoverySnapshot(participant),
          });
        },
        onFailure: (failure, error) => {
          logWarn(`[Meeting] Microphone ${failure} failed:`, error);
          emitMeetingEntryDiagnostic("local_mic_failure", {
            code: callbacksRef.current.code,
            failure,
            errorName: errorName(error),
            errorMessage: errorMessage(error),
          });
          const copy = FAILURE_TOASTS[failure];
          callbacksRef.current.addToast({
            title: copy.title,
            description: errorMessage(error) ?? copy.fallback,
            data: { variant: "error" },
          });
        },
        onDeviceLost: () => {
          emitMeetingEntryDiagnostic("local_mic_device_lost", { code: callbacksRef.current.code });
          callbacksRef.current.addToast({
            title: "Microphone disconnected",
            description: "You're muted. Your microphone turns back on when one is connected.",
            data: { variant: "error" },
          });
        },
      },
    );

    setController(next);
    return () => {
      next.dispose();
      setController(null);
    };
  }, [callbacksRef, roomInstance]);

  // LiveKit is the authority on what the track is actually doing. Mute events
  // the controller did not cause are adopted as intent so reconciliation never
  // fights teardown or a server-side mute. A publish counts too: the join's
  // first publish often lands after this controller was seeded "off", and a
  // first publish emits no unmute. A mute that follows the device ending is
  // adopted as a loss, not a choice.
  //
  // An unpublish is not adopted: nothing here unpublishes the microphone, and
  // LiveKit does so only to publish it again after a full reconnect. If that
  // republish fails, the reconnect's end is where the track has drifted from
  // what the user wants, so the controller drives it back — and says so if
  // the microphone cannot start.
  React.useEffect(() => {
    if (!roomInstance || !controller) return;
    const deviceLoss = watchLocalDeviceLoss(roomInstance, Track.Source.Microphone);

    const handleTrackMuteChanged = (
      publication: TrackPublication,
      participant: Participant,
    ) => {
      if (
        participant !== roomInstance.localParticipant ||
        publication.source !== Track.Source.Microphone
      ) {
        return;
      }
      controller.syncFromPort(deviceLoss.lost ? "device-lost" : undefined);
    };

    const handleLocalPublicationChanged = (publication: TrackPublication) => {
      handleTrackMuteChanged(publication, roomInstance.localParticipant);
    };

    const handleReconnected = () => controller.driveToIntent();

    roomInstance
      .on(RoomEvent.TrackMuted, handleTrackMuteChanged)
      .on(RoomEvent.TrackUnmuted, handleTrackMuteChanged)
      .on(RoomEvent.LocalTrackPublished, handleLocalPublicationChanged)
      .on(RoomEvent.Reconnected, handleReconnected);
    // A publish that landed between seeding and subscribing.
    controller.syncFromPort();
    return () => {
      roomInstance
        .off(RoomEvent.TrackMuted, handleTrackMuteChanged)
        .off(RoomEvent.TrackUnmuted, handleTrackMuteChanged)
        .off(RoomEvent.LocalTrackPublished, handleLocalPublicationChanged)
        .off(RoomEvent.Reconnected, handleReconnected);
      deviceLoss.dispose();
    };
  }, [roomInstance, controller]);

  React.useEffect(() => {
    if (!roomInstance || !controller) return;

    const handleMediaDevicesError = (error: Error, kind?: MediaDeviceKind) => {
      const microphoneError = roomInstance.localParticipant.lastMicrophoneError;
      const isLikelyMicrophone =
        kind === "audioinput" ||
        Boolean(microphoneError && microphoneError === error) ||
        (controller.intentOn && !roomInstance.localParticipant.lastCameraError);

      emitMeetingEntryDiagnostic("media_devices_error", {
        code,
        failure: getDeviceFailure(error),
        kind: isLikelyMicrophone ? "audioinput" : "unknown",
        errorName: error.name,
        errorMessage: error.message,
      });

      if (isLikelyMicrophone) controller.invalidateHealth();
    };

    const handleLocalAudioSilence = () => {
      if (!controller.intentOn) return;
      emitMeetingEntryDiagnostic("local_audio_silence_detected", { code });
    };

    roomInstance.on(RoomEvent.MediaDevicesError, handleMediaDevicesError);
    roomInstance.on(RoomEvent.LocalAudioSilenceDetected, handleLocalAudioSilence);
    return () => {
      roomInstance.off(RoomEvent.MediaDevicesError, handleMediaDevicesError);
      roomInstance.off(RoomEvent.LocalAudioSilenceDetected, handleLocalAudioSilence);
    };
  }, [code, roomInstance, controller]);

  // A microphone the system stopped — an iPadOS call took the audio session,
  // or capture stalled without a word — while the user still wants it on.
  // `MicrophoneInterruption` owns noticing and recovery; this binds it to the
  // room, the controller and the page.
  React.useEffect(() => {
    if (!roomInstance || !controller) return;

    const participant = roomInstance.localParticipant;
    const microphoneTrack = () => {
      const track = participant.getTrackPublication(Track.Source.Microphone)?.track;
      return track && track.kind === Track.Kind.Audio ? (track as LocalAudioTrack) : undefined;
    };

    const next = new MicrophoneInterruption(
      {
        intentOn: () => controller.intentOn,
        busy: () => controller.pending || roomInstance.state !== ConnectionState.Connected,
        observe: () => {
          const track = microphoneTrack();
          return {
            trackMuted: track ? track.mediaStreamTrack.muted : null,
            upstreamPaused: track?.isUpstreamPaused ?? false,
            audioSession: readAudioSessionState(),
          };
        },
        packetsSent: async () => {
          const stats = await microphoneTrack()?.getSenderStats();
          return stats?.packetsSent ?? null;
        },
        pageVisible: isPageVisible,
        restart: () => controller.restartCapture(),
        onNextUserGesture,
      },
      {
        onStateChange: bumpRenderVersion,
        onDiagnostic: (diagnostic) => {
          const code = callbacksRef.current.code;
          switch (diagnostic.event) {
            case "interrupted":
              emitMeetingEntryDiagnostic("local_mic_interrupted", {
                code,
                cause: diagnostic.cause,
                trackMuted: diagnostic.observation.trackMuted,
                upstreamPaused: diagnostic.observation.upstreamPaused,
                audioSession: diagnostic.observation.audioSession ?? "unsupported",
              });
              return;
            case "resume_failed":
              emitMeetingEntryDiagnostic("local_mic_resume_failed", {
                code,
                trigger: diagnostic.trigger,
                attempts: diagnostic.attempts,
                errorName: errorName(diagnostic.error),
                errorMessage: errorMessage(diagnostic.error),
              });
              return;
            case "resumed":
              emitMeetingEntryDiagnostic("local_mic_resumed", {
                code,
                via: diagnostic.via,
                cause: diagnostic.cause,
                trigger: diagnostic.trigger ?? undefined,
                attempts: diagnostic.attempts,
                interruptedForMs: diagnostic.interruptedForMs,
              });
              return;
          }
        },
      },
    );

    const check = () => next.check();
    const handleLocalTrackChanged = (publication: TrackPublication, owner?: Participant) => {
      if (owner && owner !== participant) return;
      if (publication.source === Track.Source.Microphone) check();
    };
    const handleLocalPublication = (publication: TrackPublication) => {
      handleLocalTrackChanged(publication, participant);
    };
    const audioSession = getAudioSession();

    audioSession?.addEventListener("statechange", check);
    document.addEventListener("visibilitychange", check);
    roomInstance
      .on(RoomEvent.TrackMuted, handleLocalTrackChanged)
      .on(RoomEvent.TrackUnmuted, handleLocalTrackChanged)
      .on(RoomEvent.LocalTrackPublished, handleLocalPublication)
      .on(RoomEvent.LocalTrackUnpublished, handleLocalPublication)
      .on(RoomEvent.Reconnected, check);
    setInterruption(next);
    next.start();

    return () => {
      audioSession?.removeEventListener("statechange", check);
      document.removeEventListener("visibilitychange", check);
      roomInstance
        .off(RoomEvent.TrackMuted, handleLocalTrackChanged)
        .off(RoomEvent.TrackUnmuted, handleLocalTrackChanged)
        .off(RoomEvent.LocalTrackPublished, handleLocalPublication)
        .off(RoomEvent.LocalTrackUnpublished, handleLocalPublication)
        .off(RoomEvent.Reconnected, check);
      next.dispose();
      setInterruption(null);
    };
  }, [callbacksRef, controller, roomInstance]);

  // A change of intent settles an interruption at once (muting ends it)
  // rather than at the next sample.
  const intentOn = controller?.intentOn ?? false;
  React.useEffect(() => {
    interruption?.check();
  }, [interruption, intentOn]);

  // The join's own publish usually settles after this view mounted, so its
  // outcome is waited for, not sampled: a failure that lands a moment after
  // mount is still this join's failure.
  React.useEffect(() => {
    if (!roomInstance || !controller || !initialMedia) return;
    let disposed = false;
    let cleanup = () => {};
    void initialMedia.then(({ audioError }) => {
      if (disposed || reportedInitialMedia.has(initialMedia)) return;
      reportedInitialMedia.add(initialMedia);
      if (!(audioError instanceof Error) || roomInstance.localParticipant.isMicrophoneEnabled) return;
      cleanup = reportInitialMicrophoneFailure(audioError, controller, callbacksRef.current);
    });
    return () => {
      disposed = true;
      cleanup();
    };
  }, [callbacksRef, controller, initialMedia, roomInstance]);

  const resumeMicrophone = React.useCallback(() => {
    interruption?.resumeFromUserGesture();
  }, [interruption]);

  // A microphone is available again (the device refresh has settled which
  // one): bring back a microphone that only went off with its device.
  const restoreMicAfterDeviceLoss = React.useCallback(() => {
    if (!controller?.restoreAfterDeviceLoss()) return;
    emitMeetingEntryDiagnostic("local_mic_device_restored", { code: callbacksRef.current.code });
    callbacksRef.current.addToast({
      title: "Microphone back on",
      description: "A microphone was connected, so you're unmuted again.",
      data: { variant: "info" },
    });
  }, [callbacksRef, controller]);

  const handleToggleMic = React.useCallback(() => {
    if (!controller) return;
    controller.toggle();
    callbacksRef.current.onChoice?.({ audioEnabled: controller.intentOn });
  }, [callbacksRef, controller]);

  return {
    /** The user's intent, so the control flips on click instead of on I/O. */
    isMicOn: controller?.intentOn ?? false,
    isMicPending: controller?.pending ?? false,
    /**
     * Why the microphone the user has on is not reaching the meeting — the
     * system stopped it — or null while it is. Recovery runs on its own; this
     * is for saying so.
     */
    micInterruption: interruption?.interruptionCause ?? null,
    /** Restart the stopped microphone from inside a click. */
    resumeMic: resumeMicrophone,
    restoreMicAfterDeviceLoss,
    handleToggleMic,
  };
}
