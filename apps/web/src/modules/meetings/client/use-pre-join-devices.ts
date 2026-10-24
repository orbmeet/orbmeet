import * as React from "react";
import type { LocalVideoTrack } from "livekit-client";
import { logError } from "@/lib/logger";
import {
  getConcreteMediaDevices,
  getConcreteTrackDeviceId,
  mediaDeviceIdentityKey,
  resolveJoinMediaDeviceId,
} from "@/modules/meetings/client/device-selection";
import { markMeetingEntryMetric } from "@/modules/meetings/client/entry-metrics";
import { emitMeetingEntryDiagnostic } from "@/modules/meetings/client/entry/diagnostics";
import { acquirePreJoinMedia, withProbeTimeout } from "@/modules/meetings/client/pre-join-media-probe";
import {
  type DeviceNotice,
  type MediaKindStatus,
  getDeviceNotice,
  willJoinSilent,
} from "@/modules/meetings/client/pre-join-device-status";
import {
  initialPreJoinDeviceState,
  preJoinDeviceReducer,
  type PreJoinMediaKind,
  type ProbedKind,
} from "@/modules/meetings/client/pre-join-device-state";
import { usePreJoinBackground, type PreJoinBackground } from "@/modules/meetings/client/use-pre-join-background";
import { stopStream, usePreJoinPreview } from "@/modules/meetings/client/use-pre-join-preview";

export { stopWarmupAudio } from "@/modules/meetings/client/use-pre-join-preview";

const MEDIA_PROBE_TIMEOUT_MS = 8_000;

export interface PreJoinDevicesResult extends Omit<PreJoinBackground, "applyToPreview" | "releasePreview"> {
  /** Callback ref for the camera preview's `<video>` element. */
  previewVideo: (element: HTMLVideoElement | null) => void;
  localVideoTrack: LocalVideoTrack | null;
  audioPreviewTrack: MediaStreamTrack | null;
  videoEnabled: boolean;
  audioEnabled: boolean;
  videoAvailable: boolean;
  audioAvailable: boolean;
  videoDevices: MediaDeviceInfo[];
  audioDevices: MediaDeviceInfo[];
  audioOutputDevices: MediaDeviceInfo[];
  isLoadingDevices: boolean;
  /** Why each kind is unusable. Every device string on screen derives from these. */
  cameraStatus: MediaKindStatus;
  microphoneStatus: MediaKindStatus;
  /** The one warning banner, or null when both kinds are fine. */
  deviceNotice: DeviceNotice | null;
  /** A non-blocking note about a working-but-degraded setup. */
  deviceNote: string | null;
  /** True when joining now means joining with no microphone at all. */
  joinsSilent: boolean;
  selectedVideoDevice: string | undefined;
  selectedAudioDevice: string | undefined;
  selectedAudioOutputDevice: string | undefined;
  effectiveVideoDeviceId: string | undefined;
  effectiveAudioDeviceId: string | undefined;
  onVideoDeviceChange: (deviceId: string | undefined) => void;
  onAudioDeviceChange: (deviceId: string | undefined) => void;
  onAudioOutputDeviceChange: (deviceId: string | undefined) => void;
  onVideoToggle: () => void;
  onAudioToggle: () => void;
  retryDevices: () => void;
}

/**
 * The pre-join screen's devices: the permission probe, hot-plug, the pickers
 * and toggles, the camera and microphone previews, and the background effect.
 * What the devices are and why each kind is or is not usable lives in
 * `preJoinDeviceReducer`; this hook runs the browser calls that feed it.
 */
export function usePreJoinDevices(): PreJoinDevicesResult {
  const [state, dispatch] = React.useReducer(preJoinDeviceReducer, initialPreJoinDeviceState);
  const {
    videoDesired,
    audioDesired,
    videoAvailable,
    audioAvailable,
    videoDevices,
    audioDevices,
    selectedVideoDevice,
    selectedAudioDevice,
    cameraStatus,
    microphoneStatus,
  } = state;
  const videoEnabled = videoDesired && videoAvailable;
  const audioEnabled = audioDesired && audioAvailable;
  const probeRef = React.useRef<AbortController | null>(null);
  const deviceChangeGenerationRef = React.useRef(0);

  React.useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      markMeetingEntryMetric("prejoinReadyAt");
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, []);

  const probeDevices = React.useCallback(async () => {
    dispatch({ type: "probe-started" });
    probeRef.current?.abort();
    const probe = new AbortController();
    probeRef.current = probe;
    const { signal } = probe;
    const probeStreams: MediaStream[] = [];
    const stopProbeStreams = () => {
      probeStreams.splice(0).forEach(stopStream);
    };

    try {
      if (typeof window !== "undefined" && !window.isSecureContext) {
        dispatch({ type: "probe-impossible", reason: "insecure-context" });
        return;
      }
      if (!navigator.mediaDevices?.getUserMedia || !navigator.mediaDevices?.enumerateDevices) {
        dispatch({ type: "probe-impossible", reason: "unsupported" });
        return;
      }

      let videoProbeTimedOut = false;
      let audioProbeTimedOut = false;
      let enumerateTimedOut = false;

      // The common path uses one combined request, producing one permission
      // prompt and one browser capture transaction. If hardware acquisition
      // fails for a non-permission reason, retry the kinds independently so a
      // busy/missing camera does not prevent an otherwise healthy microphone.
      const acquisition = await acquirePreJoinMedia(
        (constraints, kind) =>
          withProbeTimeout(
            navigator.mediaDevices.getUserMedia(constraints),
            MEDIA_PROBE_TIMEOUT_MS,
            () => {
              if (kind === "video" || kind === "audio_video") videoProbeTimedOut = true;
              if (kind === "audio" || kind === "audio_video") audioProbeTimedOut = true;
              emitMeetingEntryDiagnostic("device_probe_timeout", { kind, timeoutMs: MEDIA_PROBE_TIMEOUT_MS });
            },
            stopStream,
          ),
      );
      probeStreams.push(...acquisition.streams);

      const videoTrack = acquisition.videoStream?.getVideoTracks()[0];
      const audioTrack = acquisition.audioStream?.getAudioTracks()[0];
      const video: ProbedKind = {
        granted: Boolean(videoTrack),
        error: acquisition.videoError,
        timedOut: videoProbeTimedOut,
        deviceId: getConcreteTrackDeviceId(videoTrack),
      };
      const audio: ProbedKind = {
        granted: Boolean(audioTrack),
        error: acquisition.audioError,
        timedOut: audioProbeTimedOut,
        deviceId: getConcreteTrackDeviceId(audioTrack),
      };

      if (signal.aborted) return;

      // Enumerate while streams are still active — macOS clears labels once
      // all tracks are stopped, so this must happen before we release them.
      const devices = await withProbeTimeout(
        navigator.mediaDevices.enumerateDevices(),
        MEDIA_PROBE_TIMEOUT_MS,
        () => {
          enumerateTimedOut = true;
          emitMeetingEntryDiagnostic("device_probe_timeout", { kind: "enumerate", timeoutMs: MEDIA_PROBE_TIMEOUT_MS });
        },
        (lateDevices) => {
          if (!signal.aborted) dispatch({ type: "late-enumeration", video, audio, devices: lateDevices });
        },
      );
      stopProbeStreams();
      if (signal.aborted) return;

      // Enumeration is corroborating information, not the authority on whether
      // capture works; the reducer keeps the last known lists when it timed out.
      dispatch({ type: "probe-finished", video, audio, devices });
      const errorName = (error: unknown) => (error instanceof Error ? error.name : null);
      emitMeetingEntryDiagnostic("device_probe_completed", {
        ...(devices
          ? {
              videoDevices: getConcreteMediaDevices(devices, "videoinput").length,
              audioDevices: getConcreteMediaDevices(devices, "audioinput").length,
              rawVideoCount: devices.filter((d) => d.kind === "videoinput").length,
              rawAudioCount: devices.filter((d) => d.kind === "audioinput").length,
            }
          : {}),
        videoGranted: video.granted,
        audioGranted: audio.granted,
        videoErrorName: errorName(acquisition.videoError),
        audioErrorName: errorName(acquisition.audioError),
        usedSeparateProbes: acquisition.usedSeparateProbes,
        videoProbeTimedOut,
        audioProbeTimedOut,
        enumerateTimedOut,
      });
    } catch (err) {
      if (signal.aborted) return;
      logError("Failed to enumerate devices:", err);
      emitMeetingEntryDiagnostic("device_probe_failed");
      dispatch({ type: "probe-failed" });
    } finally {
      stopProbeStreams();
      if (probeRef.current === probe) dispatch({ type: "probe-settled" });
    }
  }, []);

  React.useEffect(() => {
    void probeDevices();
    return () => {
      probeRef.current?.abort();
    };
  }, [probeDevices]);

  React.useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.addEventListener) return;
    const handleDeviceChange = () => {
      const generation = ++deviceChangeGenerationRef.current;
      void navigator.mediaDevices.enumerateDevices().then((devices) => {
        if (generation === deviceChangeGenerationRef.current) dispatch({ type: "devices-changed", devices });
      }, (err: unknown) => {
        logError("Failed to refresh devices after devicechange:", err);
      });
    };
    navigator.mediaDevices.addEventListener("devicechange", handleDeviceChange);
    return () => {
      deviceChangeGenerationRef.current += 1;
      navigator.mediaDevices.removeEventListener("devicechange", handleDeviceChange);
    };
  }, []);

  const effectiveVideoDeviceId = React.useMemo(
    () => resolveJoinMediaDeviceId({
      selectedDeviceId: selectedVideoDevice,
      activeDeviceId: state.previewVideoDeviceId ?? state.probedVideoDeviceId,
      devices: videoDevices,
    }),
    [selectedVideoDevice, state.previewVideoDeviceId, state.probedVideoDeviceId, videoDevices],
  );
  // Undefined intentionally preserves the browser/OS "default" device instead
  // of pinning the meeting to whichever concrete mic the permission probe used.
  const effectiveAudioDeviceId = React.useMemo(
    () => resolveJoinMediaDeviceId({ selectedDeviceId: selectedAudioDevice, activeDeviceId: undefined, devices: audioDevices }),
    [audioDevices, selectedAudioDevice],
  );
  const warmupAudioDeviceId = React.useMemo(
    () => resolveJoinMediaDeviceId({
      selectedDeviceId: selectedAudioDevice,
      activeDeviceId: state.probedAudioDeviceId,
      devices: audioDevices,
    }),
    [selectedAudioDevice, state.probedAudioDeviceId, audioDevices],
  );
  const videoDeviceIdentity = React.useMemo(() => mediaDeviceIdentityKey(videoDevices), [videoDevices]);
  const audioDeviceIdentity = React.useMemo(() => mediaDeviceIdentityKey(audioDevices), [audioDevices]);

  const previewTrackRef = React.useRef<LocalVideoTrack | null>(null);
  const { applyToPreview, releasePreview, ...background } = usePreJoinBackground(previewTrackRef);
  const preview = usePreJoinPreview({
    videoEnabled,
    audioEnabled,
    isLoadingDevices: state.isLoadingDevices,
    selectedVideoDevice,
    selectedAudioDevice,
    warmupAudioDeviceId,
    videoDeviceIdentity,
    audioDeviceIdentity,
    dispatch,
    background: { applyToPreview, releasePreview },
    previewTrackRef,
  });

  /**
   * Turning a kind on while it is unavailable re-probes.
   *
   * That was already the behaviour, but it was invisible: the status text did
   * not change, `aria-pressed` stayed `false` because availability never
   * flipped, and the button looked broken. Dropping back to `pending` makes
   * the retry observable — the picker says "Loading…" and the banner clears —
   * so a click always visibly does something.
   */
  const toggle = React.useCallback((kind: PreJoinMediaKind, enabled: boolean, available: boolean) => {
    if (!enabled && typeof window !== "undefined" && !window.isSecureContext) {
      dispatch({ type: "insecure-context", kind });
      return;
    }
    dispatch({ type: "set-desired", kind, desired: !enabled });
    if (!enabled && !available) {
      dispatch({ type: "retrying", kind });
      void probeDevices();
    }
  }, [probeDevices]);

  const deviceStatuses = React.useMemo(
    () => ({ camera: cameraStatus, microphone: microphoneStatus }),
    [cameraStatus, microphoneStatus],
  );

  return {
    ...preview,
    ...background,
    videoEnabled,
    audioEnabled,
    videoAvailable,
    audioAvailable,
    videoDevices,
    audioDevices,
    audioOutputDevices: state.audioOutputDevices,
    isLoadingDevices: state.isLoadingDevices,
    cameraStatus,
    microphoneStatus,
    deviceNotice: React.useMemo(() => getDeviceNotice(deviceStatuses), [deviceStatuses]),
    deviceNote: state.deviceNote,
    joinsSilent: React.useMemo(() => willJoinSilent(deviceStatuses), [deviceStatuses]),
    selectedVideoDevice,
    selectedAudioDevice,
    selectedAudioOutputDevice: state.selectedAudioOutputDevice,
    effectiveVideoDeviceId,
    effectiveAudioDeviceId,
    onVideoDeviceChange: React.useCallback((deviceId: string | undefined) => {
      dispatch({ type: "select", kind: "video", deviceId });
    }, []),
    onAudioDeviceChange: React.useCallback((deviceId: string | undefined) => {
      dispatch({ type: "select", kind: "audio", deviceId });
    }, []),
    onAudioOutputDeviceChange: React.useCallback((deviceId: string | undefined) => {
      dispatch({ type: "select", kind: "audioOutput", deviceId });
    }, []),
    onVideoToggle: React.useCallback(
      () => toggle("video", videoEnabled, videoAvailable),
      [toggle, videoEnabled, videoAvailable],
    ),
    onAudioToggle: React.useCallback(
      () => toggle("audio", audioEnabled, audioAvailable),
      [toggle, audioEnabled, audioAvailable],
    ),
    retryDevices: () => {
      void probeDevices();
    },
  };
}
