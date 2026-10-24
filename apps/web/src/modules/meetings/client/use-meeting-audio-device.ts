import * as React from "react";
import { RoomEvent, type Room } from "livekit-client";
import { logError } from "@/lib/logger";
import { useCommittedRef, type useToast } from "@orbmeet/ui/react";
import {
  getConcreteMediaDevices,
  resolveRefreshedMediaDeviceSelection,
} from "@/modules/meetings/client/device-selection";
import { emitMeetingEntryDiagnostic } from "@/modules/meetings/client/entry/diagnostics";
import { canSelectAudioOutput } from "@/modules/meetings/client/speaker-test";
import { MediaOperationQueue } from "./media-operation-queue";

export function useMeetingAudioDevice({
  roomInstance,
  initialAudioDeviceId,
  initialAudioOutputDeviceId,
  addToast,
  onChoice,
}: {
  roomInstance: Room | undefined;
  initialAudioDeviceId: string | undefined;
  initialAudioOutputDeviceId: string | undefined;
  addToast: ReturnType<typeof useToast>["add"];
  /** A microphone or speaker the participant picked and LiveKit switched to. */
  onChoice?: (
    choice: { audioDeviceId: string | undefined } | { audioOutputDeviceId: string | undefined },
  ) => void;
}) {
  const onChoiceRef = useCommittedRef(onChoice);
  const [audioDevices, setAudioDevices] = React.useState<MediaDeviceInfo[]>([]);
  const [currentAudioDeviceId, setCurrentAudioDeviceId] = React.useState<string | undefined>(
    initialAudioDeviceId,
  );
  const [activeAudioDeviceId, setActiveAudioDeviceId] = React.useState<string | undefined>(undefined);
  const currentAudioDeviceIdRef = React.useRef(initialAudioDeviceId);
  const mediaOperationQueueRef = React.useRef(new MediaOperationQueue());
  const enqueueMediaOperation = React.useCallback(
    (operation: () => Promise<void>) => mediaOperationQueueRef.current.enqueue(operation),
    [],
  );

  // ── Output device (speaker) ──
  // The output device is chosen at pre-join via RoomOptions.audioOutput, but the
  // system default can change (headphones plugged in, Bluetooth connecting) and
  // the user may want to repoint output mid-meeting without rejoining. Runtime
  // switching uses room.switchActiveDevice("audiooutput"), which applies setSinkId
  // to the remote <audio> elements — gated on the browser supporting setSinkId.
  const [audioOutputDevices, setAudioOutputDevices] = React.useState<MediaDeviceInfo[]>([]);
  const [currentAudioOutputDeviceId, setCurrentAudioOutputDeviceId] = React.useState<
    string | undefined
  >(undefined);
  const [activeAudioOutputDeviceId, setActiveAudioOutputDeviceId] = React.useState<
    string | undefined
  >(undefined);
  const currentAudioOutputDeviceIdRef = React.useRef<string | undefined>(undefined);

  const refreshAudioDevices = React.useCallback(() => enqueueMediaOperation(async () => {
    try {
      if (!navigator.mediaDevices?.enumerateDevices) return;
      const devices = await navigator.mediaDevices.enumerateDevices();
      const uniqueDevices = getConcreteMediaDevices(devices, "audioinput");
      setAudioDevices(uniqueDevices);

      // Output devices: enumerate alongside input so the same hotplug refresh
      // covers both. Empty deviceId labels are expected until mic permission is
      // granted; the menu still renders them by falling back to a generic label.
      const outputDevices = canSelectAudioOutput()
        ? getConcreteMediaDevices(devices, "audiooutput")
        : [];
      setAudioOutputDevices(outputDevices);
      setActiveAudioOutputDeviceId(roomInstance?.getActiveDevice("audiooutput") ?? undefined);

      const refreshedSelection = resolveRefreshedMediaDeviceSelection({
        selectedDeviceId: currentAudioDeviceIdRef.current,
        activeDeviceId: roomInstance?.getActiveDevice("audioinput"),
        devices: uniqueDevices,
      });
      setActiveAudioDeviceId(roomInstance?.getActiveDevice("audioinput"));
      if (refreshedSelection.selectedDeviceId !== currentAudioDeviceIdRef.current) {
        currentAudioDeviceIdRef.current = refreshedSelection.selectedDeviceId;
        setCurrentAudioDeviceId(refreshedSelection.selectedDeviceId);
      }
      if (roomInstance && refreshedSelection.shouldSwitchToDefault) {
        try {
          await roomInstance.switchActiveDevice("audioinput", "default", false);
        } catch (err) {
          logError("[Meeting] Failed to recover microphone after device change:", err);
          addToast({
            title: "Microphone disconnected",
            description:
              "Could not switch to the system microphone. Reconnect a microphone and try again.",
            data: { variant: "error" },
          });
        }
      }
    } catch (err) {
      logError("[Meeting] Failed to enumerate audio devices:", err);
    }
  }), [addToast, enqueueMediaOperation, roomInstance]);

  React.useEffect(() => {
    void refreshAudioDevices();
  }, [refreshAudioDevices]);

  React.useEffect(() => {
    currentAudioDeviceIdRef.current = initialAudioDeviceId;
    setCurrentAudioDeviceId(initialAudioDeviceId);
  }, [initialAudioDeviceId, roomInstance]);

  // RoomOptions applies the pre-join speaker choice optimistically and the SDK
  // only logs failures. Verify it once the room is available so UI state never
  // claims a speaker that was not actually selected.
  React.useEffect(() => {
    currentAudioOutputDeviceIdRef.current = undefined;
    setCurrentAudioOutputDeviceId(undefined);
    if (!roomInstance || !initialAudioOutputDeviceId || !canSelectAudioOutput()) {
      return;
    }

    let active = true;
    void enqueueMediaOperation(async () => {
      if (!active) return;
      await roomInstance.switchActiveDevice("audiooutput", initialAudioOutputDeviceId, true)
      .then(() => {
        if (!active) return;
        currentAudioOutputDeviceIdRef.current = initialAudioOutputDeviceId;
        setCurrentAudioOutputDeviceId(initialAudioOutputDeviceId);
      })
      .catch((err) => {
        if (!active) return;
        logError("[Meeting] Failed to apply the pre-join speaker:", err);
        addToast({
          title: "Using system speaker",
          description: "The selected speaker is no longer available.",
          data: { variant: "info" },
        });
      });
    });

    return () => {
      active = false;
    };
  }, [addToast, enqueueMediaOperation, initialAudioOutputDeviceId, roomInstance]);

  React.useEffect(() => {
    if (!navigator.mediaDevices?.addEventListener) return;
    const handleDeviceChange = () => {
      void refreshAudioDevices();
    };
    navigator.mediaDevices.addEventListener("devicechange", handleDeviceChange);
    return () => {
      navigator.mediaDevices.removeEventListener("devicechange", handleDeviceChange);
    };
  }, [refreshAudioDevices]);

  React.useEffect(() => {
    if (!roomInstance) return;
    const handleActiveDeviceChanged = (kind: MediaDeviceKind, deviceId: string) => {
      if (kind === "audioinput") {
        setActiveAudioDeviceId(deviceId);
        emitMeetingEntryDiagnostic("active_audio_device_changed", {
          kind,
          hasExplicitSelection: Boolean(currentAudioDeviceIdRef.current),
          deviceIdPresent: deviceId.length > 0,
        });
        if (!currentAudioDeviceIdRef.current) return;
        if (deviceId === currentAudioDeviceIdRef.current) return;
        currentAudioDeviceIdRef.current = deviceId;
        setCurrentAudioDeviceId(deviceId);
        return;
      }
      if (kind === "audiooutput") {
        setActiveAudioOutputDeviceId(deviceId);
        if (!currentAudioOutputDeviceIdRef.current) return;
        if (deviceId === currentAudioOutputDeviceIdRef.current) return;
        currentAudioOutputDeviceIdRef.current = deviceId;
        setCurrentAudioOutputDeviceId(deviceId);
      }
    };
    roomInstance.on(RoomEvent.ActiveDeviceChanged, handleActiveDeviceChanged);
    return () => {
      roomInstance.off(RoomEvent.ActiveDeviceChanged, handleActiveDeviceChanged);
    };
  }, [roomInstance]);

  const handleSelectAudioDevice = React.useCallback(
    (deviceId: string | undefined) => enqueueMediaOperation(async () => {
      if (!roomInstance) return;
      if (deviceId === currentAudioDeviceIdRef.current) return;
      try {
        const switched = await roomInstance.switchActiveDevice(
          "audioinput",
          deviceId ?? "default",
          Boolean(deviceId),
        );
        if (deviceId && !switched) {
          throw new Error("The browser did not activate the requested microphone.");
        }
        currentAudioDeviceIdRef.current = deviceId;
        setCurrentAudioDeviceId(deviceId);
        onChoiceRef.current?.({ audioDeviceId: deviceId });
      } catch (err) {
        logError("[Meeting] Failed to switch microphone:", err);
        addToast({
          title: "Microphone switch failed",
          description: "Could not switch to the selected microphone. Please try again.",
          data: { variant: "error" },
        });
      }
    }),
    [addToast, enqueueMediaOperation, onChoiceRef, roomInstance],
  );

  const handleSelectAudioOutputDevice = React.useCallback(
    (deviceId: string | undefined) => enqueueMediaOperation(async () => {
      if (!roomInstance) return;
      if (deviceId === currentAudioOutputDeviceIdRef.current) return;
      try {
        await roomInstance.switchActiveDevice(
          "audiooutput",
          deviceId ?? "default",
          Boolean(deviceId),
        );
        currentAudioOutputDeviceIdRef.current = deviceId;
        setCurrentAudioOutputDeviceId(deviceId);
        onChoiceRef.current?.({ audioOutputDeviceId: deviceId });
      } catch (err) {
        logError("[Meeting] Failed to switch speaker:", err);
        addToast({
          title: "Speaker switch failed",
          description: "Could not switch to the selected speaker. Please try again.",
          data: { variant: "error" },
        });
      }
    }),
    [addToast, enqueueMediaOperation, onChoiceRef, roomInstance],
  );

  return {
    audioDevices,
    currentAudioDeviceId,
    activeAudioDeviceId,
    handleSelectAudioDevice,
    audioOutputDevices,
    currentAudioOutputDeviceId,
    activeAudioOutputDeviceId,
    handleSelectAudioOutputDevice,
    refreshAudioDevices,
  };
}
