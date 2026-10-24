import * as React from "react";
import { createLocalTracks, type LocalVideoTrack } from "livekit-client";
import { logError } from "@/lib/logger";
import { MediaResourceController } from "./media-resource-controller";
import { getConcreteTrackDeviceId } from "@/modules/meetings/client/device-selection";
import { getCameraPreviewTrackOptions } from "@/modules/meetings/client/media-quality";
import { getActiveAudioPolicy } from "@/modules/meetings/client/audio/audio-policy-context";
import type { PreJoinDeviceAction } from "@/modules/meetings/client/pre-join-device-state";
import type { PreJoinBackground } from "@/modules/meetings/client/use-pre-join-background";

// ── Audio warmup stream ───────────────────────────────────────────────────────
// Keeps a silent getUserMedia audio stream alive from device enumeration until
// LiveKit acquires the mic. Without this, LiveKit's cold-start audio request
// triggers macOS Continuity Camera to briefly activate a nearby iPhone.
// Module-level so it survives PreJoinScreen unmounting (which happens before
// LiveKit opens its own stream).

const warmupAudio = new MediaResourceController<MediaStream>(stopStream);

async function startWarmupAudio(deviceId?: string): Promise<{ stream: MediaStream | null; error: unknown }> {
  try {
    const stream = await warmupAudio.acquire(() => navigator.mediaDevices.getUserMedia({
      audio: deviceId ? { deviceId: { exact: deviceId } } : true,
    }));
    return { stream, error: null };
  } catch (error) {
    return { stream: null, error };
  }
}

export function stopStream(stream: MediaStream) {
  stream.getTracks().forEach((track) => track.stop());
}

export function stopWarmupAudio() {
  warmupAudio.clear();
}

export interface PreJoinPreviewOptions {
  videoEnabled: boolean;
  audioEnabled: boolean;
  isLoadingDevices: boolean;
  selectedVideoDevice: string | undefined;
  selectedAudioDevice: string | undefined;
  /** The microphone the warmup holds open: the chosen one, else the one the probe used. */
  warmupAudioDeviceId: string | undefined;
  /** Change when the listed devices change, so a replaced device reopens the preview. */
  videoDeviceIdentity: string;
  audioDeviceIdentity: string;
  dispatch: React.Dispatch<PreJoinDeviceAction>;
  background: Pick<PreJoinBackground, "applyToPreview" | "releasePreview">;
  /** Written with the current camera preview track, for the background picker. */
  previewTrackRef: React.RefObject<LocalVideoTrack | null>;
}

export interface PreJoinPreview {
  /** Callback ref for the `<video>` element the camera preview plays in. */
  previewVideo: (element: HTMLVideoElement | null) => void;
  localVideoTrack: LocalVideoTrack | null;
  audioPreviewTrack: MediaStreamTrack | null;
}

/**
 * The camera and microphone previews on the pre-join screen. Each reopens when
 * its kind is turned on, its device changes or the device list changes, and a
 * capture that fails marks its kind unavailable with the reason.
 */
export function usePreJoinPreview({
  videoEnabled,
  audioEnabled,
  isLoadingDevices,
  selectedVideoDevice,
  selectedAudioDevice,
  warmupAudioDeviceId,
  videoDeviceIdentity,
  audioDeviceIdentity,
  dispatch,
  background,
  previewTrackRef,
}: PreJoinPreviewOptions): PreJoinPreview {
  // State, not a ref: the attach effect below must run again when the element
  // mounts or is replaced, not only when the track changes.
  const [videoElement, setVideoElement] = React.useState<HTMLVideoElement | null>(null);
  const [audioPreviewTrack, setAudioPreviewTrack] = React.useState<MediaStreamTrack | null>(null);
  const { applyToPreview, releasePreview } = background;

  // Start warmup audio once a microphone is available. Prefer the concrete
  // probed device, but reacquire the browser default when hot-plugging removes
  // it so a one-for-one replacement heals without another permission probe.
  // Keeping the stream open prevents LiveKit's join capture from being a cold
  // start, which can trigger macOS Continuity Camera to activate an iPhone.
  // Gated by the audio policy because the surviving warmup specifically
  // addresses Continuity Camera handoff; other platforms use the ordinary
  // preview stream below.
  // No cleanup of the warmup: it must survive PreJoinScreen unmounting because
  // LiveKit doesn't open its stream until after the join API call completes.
  // stopWarmupAudio() is called from handleMeetingConnected in the parent.
  React.useEffect(() => {
    let cancelled = false;
    const preview = new MediaResourceController<MediaStream>(stopStream);
    setAudioPreviewTrack(null);

    if (!audioEnabled || isLoadingDevices) {
      stopWarmupAudio();
      return;
    }

    if (getActiveAudioPolicy().warmCaptureBeforeJoin) {
      void startWarmupAudio(warmupAudioDeviceId).then(({ stream, error }) => {
        if (cancelled) return;
        setAudioPreviewTrack(stream?.getAudioTracks()[0] ?? null);
        if (!stream && error) dispatch({ type: "capture-failed", kind: "audio", error });
      });
      return () => {
        cancelled = true;
      };
    }

    stopWarmupAudio();
    void preview.acquire(() => navigator.mediaDevices.getUserMedia({
      audio: selectedAudioDevice ? { deviceId: { exact: selectedAudioDevice } } : true,
    }))
      .then((stream) => {
        if (!stream) return;
        setAudioPreviewTrack(stream.getAudioTracks()[0] ?? null);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setAudioPreviewTrack(null);
        dispatch({ type: "capture-failed", kind: "audio", error });
      });

    return () => {
      cancelled = true;
      preview.clear();
    };
  }, [audioEnabled, warmupAudioDeviceId, selectedAudioDevice, audioDeviceIdentity, isLoadingDevices, dispatch]);

  const camera = React.useMemo(() => new MediaResourceController<LocalVideoTrack>(async (track) => {
    try { await releasePreview(track); }
    finally {
      track.stop();
      track.mediaStreamTrack?.stop();
    }
  }, (error) => logError("Camera cleanup failed:", error)), [releasePreview]);
  const cameraState = React.useSyncExternalStore(camera.subscribe, camera.getSnapshot, camera.getSnapshot);
  const localVideoTrack = cameraState.resource;
  React.useLayoutEffect(() => {
    previewTrackRef.current = localVideoTrack;
  }, [localVideoTrack, previewTrackRef]);

  React.useEffect(() => {
    dispatch({ type: "preview-closed" });
    if (!videoEnabled || isLoadingDevices) {
      camera.clear();
      return;
    }
    if (typeof window !== "undefined" && !window.isSecureContext) {
      dispatch({ type: "insecure-context", kind: "video" });
      camera.clear();
      return;
    }
    void camera.acquire(async () => {
      const tracks = await createLocalTracks(getCameraPreviewTrackOptions(selectedVideoDevice));
      const track = tracks.find((candidate) => candidate.kind === "video") as LocalVideoTrack | undefined;
      for (const candidate of tracks) if (candidate !== track) candidate.stop();
      if (!track) throw new Error("Camera did not return a video track");
      return track;
    }).then((track) => {
      if (!track || camera.getSnapshot().resource !== track) return;
      dispatch({
        type: "preview-opened",
        deviceId: getConcreteTrackDeviceId(track.mediaStreamTrack) ?? selectedVideoDevice,
      });
      return applyToPreview(track, () => camera.getSnapshot().resource === track);
    }).catch((error: unknown) => {
      if (camera.getSnapshot().phase !== "failed") return;
      logError("Failed to create video track:", error);
      dispatch({ type: "capture-failed", kind: "video", error });
    });
    return camera.clear;
  }, [camera, videoEnabled, isLoadingDevices, selectedVideoDevice, videoDeviceIdentity, applyToPreview, dispatch]);

  React.useEffect(() => {
    if (!localVideoTrack || !videoElement) return;
    localVideoTrack.attach(videoElement);
    return () => { localVideoTrack.detach(videoElement); };
  }, [localVideoTrack, videoElement]);

  return { previewVideo: setVideoElement, localVideoTrack, audioPreviewTrack };
}
