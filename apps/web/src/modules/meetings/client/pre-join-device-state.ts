/**
 * The pre-join screen's device state, as one reducer.
 *
 * The permission probe, a hot-plug, a picker choice and a failed capture all
 * change the same facts — which devices exist, which one is chosen, whether
 * each kind can be used and why not. Kept as one pure transition per event,
 * those facts cannot drift apart between the effects that report them, and a
 * choice of a device that is no longer listed is dropped in the same step
 * that changed the list.
 */

import { getConcreteMediaDevices, resolvePreJoinDeviceAvailability } from "@/modules/meetings/client/device-selection";
import {
  applyDeviceChangeToStatus,
  classifyDeviceFailure,
  type DeviceUnavailableReason,
  type MediaKindStatus,
} from "@/modules/meetings/client/pre-join-device-status";

export type PreJoinMediaKind = "video" | "audio";

export interface PreJoinDeviceState {
  /**
   * What the user wants, kept apart from whether the hardware is usable: a
   * failed probe makes a kind unavailable without erasing the intent, so a
   * successful retry restores the preview but never unmutes someone who
   * chose to stay muted.
   */
  videoDesired: boolean;
  audioDesired: boolean;
  videoAvailable: boolean;
  audioAvailable: boolean;
  videoDevices: MediaDeviceInfo[];
  audioDevices: MediaDeviceInfo[];
  audioOutputDevices: MediaDeviceInfo[];
  selectedVideoDevice: string | undefined;
  selectedAudioDevice: string | undefined;
  selectedAudioOutputDevice: string | undefined;
  /** The camera the running preview actually opened. */
  previewVideoDeviceId: string | undefined;
  /** The devices the permission probe opened, when still listed. */
  probedVideoDeviceId: string | undefined;
  probedAudioDeviceId: string | undefined;
  isLoadingDevices: boolean;
  /** Why each kind is unusable. Every device string on screen derives from these. */
  cameraStatus: MediaKindStatus;
  microphoneStatus: MediaKindStatus;
  /** A device that works but could not be listed, or a probe that ran long. Never a failure. */
  deviceNote: string | null;
}

/** One kind's outcome from the permission probe. */
export interface ProbedKind {
  granted: boolean;
  error: unknown;
  timedOut: boolean;
  /** The concrete device the probe's track opened. */
  deviceId: string | undefined;
}

export type PreJoinDeviceAction =
  | { type: "probe-started" }
  /** No probe can run here at all. */
  | { type: "probe-impossible"; reason: Extract<DeviceUnavailableReason, "insecure-context" | "unsupported"> }
  /** `devices` is null when enumeration timed out. */
  | { type: "probe-finished"; video: ProbedKind; audio: ProbedKind; devices: MediaDeviceInfo[] | null }
  /** The enumeration a timed-out probe gave up on arrived after all. */
  | { type: "late-enumeration"; video: ProbedKind; audio: ProbedKind; devices: MediaDeviceInfo[] }
  | { type: "probe-failed" }
  | { type: "probe-settled" }
  /** A device was plugged in or removed. */
  | { type: "devices-changed"; devices: MediaDeviceInfo[] }
  | { type: "select"; kind: PreJoinMediaKind | "audioOutput"; deviceId: string | undefined }
  | { type: "set-desired"; kind: PreJoinMediaKind; desired: boolean }
  /** A retry is about to run: show it as pending so the click visibly does something. */
  | { type: "retrying"; kind: PreJoinMediaKind }
  | { type: "insecure-context"; kind: PreJoinMediaKind }
  | { type: "preview-opened"; deviceId: string | undefined }
  | { type: "preview-closed" }
  | { type: "capture-failed"; kind: PreJoinMediaKind; error: unknown };

export const initialPreJoinDeviceState: PreJoinDeviceState = {
  videoDesired: true,
  audioDesired: true,
  videoAvailable: false,
  audioAvailable: false,
  videoDevices: [],
  audioDevices: [],
  audioOutputDevices: [],
  selectedVideoDevice: undefined,
  selectedAudioDevice: undefined,
  selectedAudioOutputDevice: undefined,
  previewVideoDeviceId: undefined,
  probedVideoDeviceId: undefined,
  probedAudioDeviceId: undefined,
  isLoadingDevices: true,
  cameraStatus: { state: "pending" },
  microphoneStatus: { state: "pending" },
  deviceNote: null,
};

const STATUS_KEY = { video: "cameraStatus", audio: "microphoneStatus" } as const;
const AVAILABLE_KEY = { video: "videoAvailable", audio: "audioAvailable" } as const;
const DESIRED_KEY = { video: "videoDesired", audio: "audioDesired" } as const;
const SELECTED_KEY = {
  video: "selectedVideoDevice",
  audio: "selectedAudioDevice",
  audioOutput: "selectedAudioOutputDevice",
} as const;

function listed(devices: readonly MediaDeviceInfo[], deviceId: string | undefined): string | undefined {
  return deviceId && devices.some((device) => device.deviceId === deviceId) ? deviceId : undefined;
}

function kindStatus(kind: ProbedKind, enumeratedCount: number | null): MediaKindStatus {
  return kind.granted
    ? { state: "ready" }
    : {
        state: "unavailable",
        reason: classifyDeviceFailure({ error: kind.error, enumeratedCount, timedOut: kind.timedOut }),
      };
}

/**
 * Drop a choice the device lists no longer offer. An input choice survives an
 * empty list (nothing was enumerated, which is not the same as the device
 * leaving); an output choice does not.
 */
function reconcileSelections(state: PreJoinDeviceState): PreJoinDeviceState {
  const video = state.videoDevices.length === 0 || !state.selectedVideoDevice
    ? state.selectedVideoDevice
    : listed(state.videoDevices, state.selectedVideoDevice);
  const audio = state.audioDevices.length === 0 || !state.selectedAudioDevice
    ? state.selectedAudioDevice
    : listed(state.audioDevices, state.selectedAudioDevice);
  const output = listed(state.audioOutputDevices, state.selectedAudioOutputDevice);
  if (
    video === state.selectedVideoDevice
    && audio === state.selectedAudioDevice
    && output === state.selectedAudioOutputDevice
  ) {
    return state;
  }
  return { ...state, selectedVideoDevice: video, selectedAudioDevice: audio, selectedAudioOutputDevice: output };
}

function withDeviceLists(state: PreJoinDeviceState, devices: MediaDeviceInfo[]): PreJoinDeviceState {
  return {
    ...state,
    videoDevices: getConcreteMediaDevices(devices, "videoinput"),
    audioDevices: getConcreteMediaDevices(devices, "audioinput"),
    audioOutputDevices: getConcreteMediaDevices(devices, "audiooutput"),
  };
}

function finishProbe(
  state: PreJoinDeviceState,
  video: ProbedKind,
  audio: ProbedKind,
  devices: MediaDeviceInfo[] | null,
): PreJoinDeviceState {
  if (devices === null) {
    // Enumeration timing out says nothing about capture: keep the last known
    // lists and choices, and whatever the probe got stays usable through the
    // system default.
    return {
      ...state,
      probedVideoDeviceId: video.deviceId,
      probedAudioDeviceId: audio.deviceId,
      videoAvailable: video.granted || state.videoAvailable,
      audioAvailable: audio.granted || state.audioAvailable,
      cameraStatus: kindStatus(video, null),
      microphoneStatus: kindStatus(audio, null),
      deviceNote: video.granted || audio.granted
        ? "Device discovery is taking longer than expected. Your available camera and microphone will keep using the system defaults."
        : state.deviceNote,
    };
  }

  const next = withDeviceLists(state, devices);
  const hasCamera = next.videoDevices.length > 0;
  const hasMicrophone = next.audioDevices.length > 0;
  // Classification counts the browser's raw entries, not the concrete ones. A
  // denied permission leaves a blank-`deviceId` placeholder that
  // `getConcreteMediaDevices` strips; counting the stripped list would turn
  // "blocked" into "not detected".
  const rawVideoCount = devices.filter((device) => device.kind === "videoinput").length;
  const rawAudioCount = devices.filter((device) => device.kind === "audioinput").length;

  // Capture worked but the browser withheld the device list. The meeting is
  // fine, it just cannot offer a picker: a note, not a failure.
  const unlisted: string[] = [];
  if (video.granted && !hasCamera) unlisted.push("camera");
  if (audio.granted && !hasMicrophone) unlisted.push("microphone");
  const deviceNote = unlisted.length === 2
    ? "Your camera and microphone are available, but this browser could not list them. The system defaults will be used."
    : unlisted.length === 1
      ? `Your ${unlisted[0]} is available, but this browser could not list it. The system default will be used.`
      : null;

  return reconcileSelections({
    ...next,
    probedVideoDeviceId: listed(next.videoDevices, video.deviceId),
    probedAudioDeviceId: listed(next.audioDevices, audio.deviceId),
    videoAvailable: video.granted,
    audioAvailable: audio.granted,
    selectedVideoDevice: !hasCamera && !video.granted ? undefined : next.selectedVideoDevice,
    selectedAudioDevice: !hasMicrophone && !audio.granted ? undefined : next.selectedAudioDevice,
    cameraStatus: kindStatus(video, rawVideoCount),
    microphoneStatus: kindStatus(audio, rawAudioCount),
    deviceNote,
  });
}

export function preJoinDeviceReducer(state: PreJoinDeviceState, action: PreJoinDeviceAction): PreJoinDeviceState {
  switch (action.type) {
    case "probe-started":
      return {
        ...state,
        isLoadingDevices: true,
        cameraStatus: { state: "pending" },
        microphoneStatus: { state: "pending" },
        deviceNote: null,
      };
    case "probe-impossible":
      return {
        ...state,
        videoAvailable: false,
        audioAvailable: false,
        videoDevices: [],
        audioDevices: [],
        audioOutputDevices: [],
        previewVideoDeviceId: undefined,
        probedVideoDeviceId: undefined,
        probedAudioDeviceId: undefined,
        cameraStatus: { state: "unavailable", reason: action.reason },
        microphoneStatus: { state: "unavailable", reason: action.reason },
      };
    case "probe-finished":
      return finishProbe(state, action.video, action.audio, action.devices);
    case "late-enumeration": {
      // The pickers catch up without another permission prompt.
      const next = withDeviceLists(state, action.devices);
      return reconcileSelections({
        ...next,
        probedVideoDeviceId: listed(next.videoDevices, action.video.deviceId),
        probedAudioDeviceId: listed(next.audioDevices, action.audio.deviceId),
        videoAvailable: action.video.granted || next.videoAvailable,
        audioAvailable: action.audio.granted || next.audioAvailable,
        deviceNote: next.videoDevices.length > 0 && next.audioDevices.length > 0 ? null : next.deviceNote,
      });
    }
    case "probe-failed":
      return {
        ...state,
        videoAvailable: false,
        audioAvailable: false,
        selectedVideoDevice: undefined,
        selectedAudioDevice: undefined,
        previewVideoDeviceId: undefined,
        probedVideoDeviceId: undefined,
        probedAudioDeviceId: undefined,
        cameraStatus: { state: "unavailable", reason: "unknown" },
        microphoneStatus: { state: "unavailable", reason: "unknown" },
      };
    case "probe-settled":
      return { ...state, isLoadingDevices: false };
    case "devices-changed": {
      // Hot-plug refreshes availability at once; the capture effects stay the
      // authority on whether a present device can actually be opened.
      const next = withDeviceLists(state, action.devices);
      const availability = resolvePreJoinDeviceAvailability({
        videoDevices: next.videoDevices,
        audioDevices: next.audioDevices,
      });
      const noCamera = next.videoDevices.length === 0;
      const noMicrophone = next.audioDevices.length === 0;
      const missingCamera = availability.missing === "all" || availability.missing === "videoinput";
      const missingMicrophone = availability.missing === "all" || availability.missing === "audioinput";
      return reconcileSelections({
        ...next,
        videoAvailable: availability.videoAvailable,
        audioAvailable: availability.audioAvailable,
        selectedVideoDevice: noCamera ? undefined : next.selectedVideoDevice,
        previewVideoDeviceId: noCamera ? undefined : next.previewVideoDeviceId,
        probedVideoDeviceId: noCamera ? undefined : next.probedVideoDeviceId,
        selectedAudioDevice: noMicrophone ? undefined : next.selectedAudioDevice,
        probedAudioDeviceId: noMicrophone ? undefined : next.probedAudioDeviceId,
        // `applyDeviceChangeToStatus` keeps a truthful permission block from
        // being overwritten with "not detected".
        cameraStatus: applyDeviceChangeToStatus(next.cameraStatus, !missingCamera),
        microphoneStatus: applyDeviceChangeToStatus(next.microphoneStatus, !missingMicrophone),
      });
    }
    case "select":
      return reconcileSelections({ ...state, [SELECTED_KEY[action.kind]]: action.deviceId });
    case "set-desired":
      return { ...state, [DESIRED_KEY[action.kind]]: action.desired };
    case "retrying":
      return { ...state, [STATUS_KEY[action.kind]]: { state: "pending" } };
    case "insecure-context":
      return { ...state, [STATUS_KEY[action.kind]]: { state: "unavailable", reason: "insecure-context" } };
    case "preview-opened":
      return { ...state, previewVideoDeviceId: action.deviceId };
    case "preview-closed":
      return state.previewVideoDeviceId === undefined ? state : { ...state, previewVideoDeviceId: undefined };
    case "capture-failed": {
      const devices = action.kind === "video" ? state.videoDevices : state.audioDevices;
      return {
        ...state,
        [AVAILABLE_KEY[action.kind]]: false,
        [STATUS_KEY[action.kind]]: {
          state: "unavailable",
          reason: classifyDeviceFailure({ error: action.error, enumeratedCount: devices.length }),
        },
      };
    }
  }
}
