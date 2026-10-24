import * as React from "react";
import { RoomEvent, Track, type Room, type LocalVideoTrack } from "livekit-client";
import { logError } from "@/lib/logger";
import type { useToast } from "@orbmeet/ui/react";
import {
  getCameraCaptureOptions,
  getCameraPublishOptions,
  isWebKit,
} from "./media-quality";
import { shouldRestartCameraAfterRotation } from "./camera-rotation-recovery";
import {
  getConcreteMediaDevices,
  resolveRefreshedMediaDeviceSelection,
} from "./device-selection";
import { useCommittedRef } from "@orbmeet/ui/react";
import { MediaOperationQueue } from "./media-operation-queue";

// iOS rotates an active camera capture lazily — and some WebKit versions not
// at all — so after a device rotation the published frames can stay in the old
// orientation. Give the OS this long to catch up on its own before checking.
const ROTATION_SETTLE_MS = 1500;

/**
 * Point the camera at a device, or at the system's choice (`undefined`).
 *
 * LiveKit owns the camera constraint: `switchActiveDevice` stores it in the
 * room's capture defaults, which every later capture merges in, and restarts
 * the published track on it. A camera that is off keeps the change pending
 * until it is turned on, so choosing a device never turns the camera on. The
 * system's choice is LiveKit's own default constraint, a non-exact
 * `"default"`, which replaces the exact device stored by an earlier choice.
 *
 * Resolves whether a chosen device is the one now capturing; the system's
 * choice has no device to compare, so it resolves true once applied.
 */
async function switchCamera(room: Room, deviceId: string | undefined): Promise<boolean> {
  const switched = await room.switchActiveDevice("videoinput", deviceId ?? "default", Boolean(deviceId));
  return deviceId === undefined || switched;
}

export function useMeetingCamera({
  roomInstance,
  isCameraOn,
  initialVideoDeviceId,
  addToast,
  onChoice,
}: {
  roomInstance: Room | undefined;
  isCameraOn: boolean;
  initialVideoDeviceId: string | undefined;
  addToast: ReturnType<typeof useToast>["add"];
  /** A camera choice the participant made and LiveKit applied. */
  onChoice?: (choice: { videoEnabled: boolean } | { videoDeviceId: string | undefined }) => void;
}) {
  const [videoDevices, setVideoDevices] = React.useState<MediaDeviceInfo[]>([]);
  const [currentVideoDeviceId, setCurrentVideoDeviceId] = React.useState<string | undefined>(initialVideoDeviceId);
  // Ref keeps the latest device ID available inside refreshVideoDevices without
  // making it a dep — preventing spurious re-creations on every device switch.
  const currentVideoDeviceIdRef = React.useRef<string | undefined>(initialVideoDeviceId);
  const userActionQueueRef = React.useRef(new MediaOperationQueue());
  const refreshGenerationRef = React.useRef(0);
  const onChoiceRef = useCommittedRef(onChoice);

  // Device capture mutations are serialized. A second click or selection is
  // intent, not noise: queueing it means rapid toggle/toggle and switch/toggle
  // sequences settle in the order the user requested instead of silently
  // disappearing behind an in-flight browser permission or track restart.
  const enqueueUserAction = React.useCallback((action: () => Promise<void>) => {
    return userActionQueueRef.current.enqueue(action);
  }, []);

  const refreshVideoDevices = React.useCallback(() => enqueueUserAction(async () => {
    const generation = ++refreshGenerationRef.current;
    try {
      if (!navigator.mediaDevices?.enumerateDevices) return;
      const devices = await navigator.mediaDevices.enumerateDevices();
      if (generation !== refreshGenerationRef.current) return;
      const uniqueDevices = getConcreteMediaDevices(devices, "videoinput");
      setVideoDevices(uniqueDevices);
      const refreshedSelection = resolveRefreshedMediaDeviceSelection({
        selectedDeviceId: currentVideoDeviceIdRef.current,
        activeDeviceId: roomInstance?.getActiveDevice("videoinput"),
        devices: uniqueDevices,
      });
      if (refreshedSelection.selectedDeviceId !== currentVideoDeviceIdRef.current) {
        currentVideoDeviceIdRef.current = refreshedSelection.selectedDeviceId;
        setCurrentVideoDeviceId(refreshedSelection.selectedDeviceId);
      }

      // Also while the camera is off: the stored constraint still names the
      // device that is gone, and turning the camera on would ask for it.
      if (roomInstance && refreshedSelection.shouldSwitchToDefault) {
        try {
          await switchCamera(roomInstance, undefined);
        } catch (err) {
          logError("[Meeting] Failed to recover camera after device change:", err);
          addToast({
            title: "Camera disconnected",
            description:
              "Could not switch to the system camera. Reconnect a camera and try again.",
            data: { variant: "error" },
          });
        }
      }
    } catch (err) {
      logError("[Meeting] Failed to enumerate video devices:", err);
    }
  }), [addToast, enqueueUserAction, roomInstance]);

  React.useEffect(() => {
    if (!roomInstance) return;

    const reportedErrors = new WeakSet<Error>();
    const reportCameraFailure = (error: Error) => {
      if (reportedErrors.has(error)) return;
      reportedErrors.add(error);
      addToast({
        title: "Joined with camera off",
        description:
          "The selected camera could not start. Choose another camera, then turn video on.",
        data: { variant: "error" },
      });
    };

    const initialError = roomInstance.localParticipant.lastCameraError;
    if (initialError && !roomInstance.localParticipant.isCameraEnabled) {
      reportCameraFailure(initialError);
    }

    const handleMediaDevicesError = (error: Error, kind?: MediaDeviceKind) => {
      if (
        kind === "videoinput" ||
        roomInstance.localParticipant.lastCameraError === error
      ) {
        reportCameraFailure(error);
      }
    };

    const handleActiveDeviceChanged = (kind: MediaDeviceKind, deviceId: string) => {
      if (kind !== "videoinput") return;
      const nextDeviceId = deviceId === "default" ? undefined : deviceId;
      currentVideoDeviceIdRef.current = nextDeviceId;
      setCurrentVideoDeviceId(nextDeviceId);
    };

    roomInstance.on(RoomEvent.MediaDevicesError, handleMediaDevicesError);
    roomInstance.on(RoomEvent.ActiveDeviceChanged, handleActiveDeviceChanged);
    return () => {
      roomInstance.off(RoomEvent.MediaDevicesError, handleMediaDevicesError);
      roomInstance.off(RoomEvent.ActiveDeviceChanged, handleActiveDeviceChanged);
    };
  }, [addToast, roomInstance]);

  React.useEffect(() => {
    void refreshVideoDevices();
  }, [refreshVideoDevices]);

  React.useEffect(() => {
    if (!navigator.mediaDevices?.addEventListener) return;
    const handleDeviceChange = () => {
      void refreshVideoDevices();
    };
    navigator.mediaDevices.addEventListener("devicechange", handleDeviceChange);
    return () => {
      navigator.mediaDevices.removeEventListener("devicechange", handleDeviceChange);
    };
  }, [refreshVideoDevices]);

  // Refresh devices when camera is turned on
  React.useEffect(() => {
    if (isCameraOn) {
      const timeout = setTimeout(() => {
        void refreshVideoDevices();
      }, 500);
      return () => clearTimeout(timeout);
    }
  }, [isCameraOn, refreshVideoDevices]);

  // After a rotation settles, restart the capture only when the viewport
  // actually rotated and the track's orientation failed to follow it — see
  // `shouldRestartCameraAfterRotation` for the rotation-lock rationale. Modern
  // iOS usually rotates the pipeline itself, and restarting on top of that
  // would double the blink.
  React.useEffect(() => {
    if (!roomInstance) return;
    if (typeof window === "undefined" || !isWebKit()) return;

    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastViewportPortrait = window.innerHeight > window.innerWidth;

    const recoverIfStuck = () => enqueueUserAction(async () => {
      const pub = roomInstance.localParticipant.getTrackPublication(Track.Source.Camera);
      const track = pub?.track as LocalVideoTrack | undefined;
      if (!track || track.isMuted) return;

      const viewportPortrait = window.innerHeight > window.innerWidth;

      const { width, height } = track.mediaStreamTrack?.getSettings() ?? {};
      const decision = shouldRestartCameraAfterRotation({
        lastViewportPortrait,
        viewportPortrait,
        trackWidth: width,
        trackHeight: height,
      });
      lastViewportPortrait = decision.nextViewportPortrait;
      if (!decision.restart) return;

      try {
        await track.restartTrack();
      } catch (err) {
        logError("[Meeting] Failed to restart camera after rotation:", err);
      }
    });

    const handleOrientationChange = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void recoverIfStuck(), ROTATION_SETTLE_MS);
    };

    window.addEventListener("orientationchange", handleOrientationChange);
    window.screen?.orientation?.addEventListener?.("change", handleOrientationChange);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("orientationchange", handleOrientationChange);
      window.screen?.orientation?.removeEventListener?.("change", handleOrientationChange);
    };
  }, [enqueueUserAction, roomInstance]);

  const handleSelectVideoDevice = React.useCallback(
    (deviceId: string | undefined) => enqueueUserAction(async () => {
      if (!roomInstance) return;
      if (deviceId === currentVideoDeviceIdRef.current) return;
      try {
        if (!(await switchCamera(roomInstance, deviceId))) {
          throw new Error("The browser did not activate the requested camera.");
        }
        currentVideoDeviceIdRef.current = deviceId;
        setCurrentVideoDeviceId(deviceId);
        onChoiceRef.current?.({ videoDeviceId: deviceId });
      } catch (err) {
        logError("[Meeting] Failed to switch camera:", err);
        addToast({
          title: "Camera switch failed",
          description: "Could not switch to the selected camera. Please try again.",
          data: { variant: "error" },
        });
      }
    }),
    [roomInstance, addToast, enqueueUserAction, onChoiceRef],
  );

  const handleToggleCamera = React.useCallback(
    () => enqueueUserAction(async () => {
      if (!roomInstance) return;
      const lp = roomInstance.localParticipant;
      const nextEnabled = !lp.isCameraEnabled;

      try {
        if (!nextEnabled) {
          await lp.setCameraEnabled(false);
        } else {
          await lp.setCameraEnabled(
            true,
            getCameraCaptureOptions(currentVideoDeviceIdRef.current),
            getCameraPublishOptions(),
          );
        }
        onChoiceRef.current?.({ videoEnabled: nextEnabled });
      } catch (err) {
        logError("[Meeting] Failed to toggle camera:", err);
        addToast({
          title: "Camera toggle failed",
          description: "Could not update your camera. Please try again.",
          data: { variant: "error" },
        });
      }
    }),
    [roomInstance, addToast, enqueueUserAction, onChoiceRef],
  );

  return {
    videoDevices,
    currentVideoDeviceId,
    handleToggleCamera,
    handleSelectVideoDevice,
    refreshVideoDevices,
  };
}
