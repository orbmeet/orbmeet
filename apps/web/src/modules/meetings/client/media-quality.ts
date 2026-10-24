import {
  AudioPresets,
  VideoPresets,
  VideoPresets43,
  type AudioCaptureOptions,
  type CreateLocalTracksOptions,
  type RoomOptions,
  type ScreenShareCaptureOptions,
  type TrackPublishOptions,
  type VideoCaptureOptions,
} from "livekit-client";
import {
  canCaptureDisplayAudio,
  getPlatformEnvironment,
  hasVoiceProcessingPlaybackBug,
  prefersMobileCaptureProfile,
  supportsHighResDisplayCapture,
  type PlatformEnvironment,
} from "@/lib/browser-capabilities";
import {
  getActiveAudioPolicy,
  getAudioPolicyForEnvironment,
  type AudioPolicy,
} from "@/modules/meetings/client/audio/audio-policy-context";
import { loadShareScreenSound } from "./screen-share-sound";

export type BrowserMediaEnvironment = PlatformEnvironment;

export function isWebKitEnvironment(env: BrowserMediaEnvironment): boolean {
  return hasVoiceProcessingPlaybackBug(env);
}

export function isWebKit(): boolean {
  return hasVoiceProcessingPlaybackBug(getPlatformEnvironment());
}

const CAMERA_CAPTURE_DEFAULTS: VideoCaptureOptions = {
  resolution: VideoPresets.h720.resolution,
};

/**
 * A phone captures at its front camera's own shape, 4:3. Asked for 16:9, iOS
 * Safari crops the sensor to get it — a tighter, oddly framed face — and a
 * phone held upright then crops it again to fill a portrait tile. 540p either
 * way: the budget is the height, not the shape.
 */
const MOBILE_CAMERA_CAPTURE_DEFAULTS: VideoCaptureOptions = {
  resolution: VideoPresets43.h540.resolution,
};

export const DESKTOP_CAMERA_PUBLISH_OPTIONS: TrackPublishOptions = {
  videoCodec: "h264",
  simulcast: true,
  videoEncoding: VideoPresets.h720.encoding,
  videoSimulcastLayers: [VideoPresets.h180, VideoPresets.h360],
  degradationPreference: "maintain-framerate",
};

export const MOBILE_CAMERA_PUBLISH_OPTIONS: TrackPublishOptions = {
  videoCodec: "h264",
  simulcast: true,
  videoEncoding: VideoPresets43.h540.encoding,
  // The source plus one lower layer gives mobile subscribers adaptation
  // without making the handset run three simultaneous encoders.
  videoSimulcastLayers: [VideoPresets43.h180],
  degradationPreference: "balanced",
};

// Note on Safari/WebKit: of these, only echoCancellation is honored — WebKit's
// constraint dictionary has no voiceIsolation/noiseSuppression/autoGainControl/
// channelCount members, so it silently drops them (verified against WebKit
// main, MediaTrackConstraints.idl). voiceIsolation currently only takes effect
// on select ChromeOS devices.
export const AUDIO_CAPTURE_DEFAULTS: AudioCaptureOptions = {
  autoGainControl: true,
  channelCount: 1,
  echoCancellation: true,
  noiseSuppression: true,
  voiceIsolation: true,
};

function getAudioCaptureDefaults(policy: AudioPolicy): AudioCaptureOptions {
  return { ...AUDIO_CAPTURE_DEFAULTS, echoCancellation: policy.echoCancellation };
}

// Keep microphone publishing aligned with LiveKit's conferencing defaults:
// 48 kbps mono Opus, RED for burst-loss recovery, and DTX between talkspurts.
export const AUDIO_PUBLISH_OPTIONS: TrackPublishOptions = {
  audioPreset: AudioPresets.music,
  red: true,
  dtx: true,
  forceStereo: false,
};

export const INTERACTIVE_ROOM_MEDIA_OPTIONS: RoomOptions = {
  dynacast: true,
  adaptiveStream: true,
  audioCaptureDefaults: AUDIO_CAPTURE_DEFAULTS,
  videoCaptureDefaults: CAMERA_CAPTURE_DEFAULTS,
  // publishDefaults is shared by audio + video tracks; the camera track is
  // published explicitly with CAMERA_PUBLISH_OPTIONS, so the audio fields here
  // only reach the mic track.
  publishDefaults: { ...DESKTOP_CAMERA_PUBLISH_OPTIONS, ...AUDIO_PUBLISH_OPTIONS },
};

export const RECORDER_ROOM_MEDIA_OPTIONS: RoomOptions = {
  dynacast: true,
  adaptiveStream: true,
  disconnectOnPageLeave: true,
};

export const SCREEN_SHARE_PUBLISH_OPTIONS: TrackPublishOptions = {
  videoCodec: "h264",
  simulcast: true,
  screenShareEncoding: VideoPresets.h1080.encoding,
  screenShareSimulcastLayers: [VideoPresets.h360, VideoPresets.h720],
};

// Screen-share audio is media (a video's soundtrack, slide audio), not voice:
// the 24 kbps speech preset would compress it harshly. Use the music preset
// (48 kbps mono) and keep RED on for the same burst-loss resilience. DTX is
// off because screen audio isn't talkspurt-shaped — suppressing "silence"
// here would clip trailing media audio and the gaps between sustained sounds.
export const SCREEN_SHARE_AUDIO_PUBLISH_OPTIONS: TrackPublishOptions = {
  audioPreset: AudioPresets.music,
  red: true,
  dtx: false,
};

export function getAudioCaptureOptions(deviceId?: string): AudioCaptureOptions {
  const defaults = getAudioCaptureDefaults(getActiveAudioPolicy());
  return deviceId ? { ...defaults, deviceId } : defaults;
}

export function getCameraCaptureOptions(deviceId?: string): VideoCaptureOptions {
  return getCameraCaptureOptionsForEnvironment(getPlatformEnvironment(), deviceId);
}

export function getCameraCaptureOptionsForEnvironment(
  env: BrowserMediaEnvironment,
  deviceId?: string,
): VideoCaptureOptions {
  const defaults = prefersMobileCaptureProfile(env)
    ? MOBILE_CAMERA_CAPTURE_DEFAULTS
    : CAMERA_CAPTURE_DEFAULTS;
  return deviceId
    ? { ...defaults, deviceId }
    : { ...defaults };
}

export function getCameraPublishOptionsForEnvironment(
  env: BrowserMediaEnvironment,
): TrackPublishOptions {
  return prefersMobileCaptureProfile(env)
    ? MOBILE_CAMERA_PUBLISH_OPTIONS
    : DESKTOP_CAMERA_PUBLISH_OPTIONS;
}

export function getCameraPublishOptions(): TrackPublishOptions {
  return getCameraPublishOptionsForEnvironment(getPlatformEnvironment());
}

export function getInteractiveRoomMediaOptionsForEnvironment(
  env: BrowserMediaEnvironment,
  policy: AudioPolicy = getAudioPolicyForEnvironment(env),
): RoomOptions {
  return {
    ...INTERACTIVE_ROOM_MEDIA_OPTIONS,
    audioCaptureDefaults: getAudioCaptureDefaults(policy),
    videoCaptureDefaults: getCameraCaptureOptionsForEnvironment(env),
    publishDefaults: {
      ...getCameraPublishOptionsForEnvironment(env),
      ...AUDIO_PUBLISH_OPTIONS,
      // A muted LiveKit track keeps the capture session alive; stopping it on
      // mute returns playback to the clean media route while muted, at the cost
      // of a slightly slower unmute. See audio-policy.ts for why.
      stopMicTrackOnMute: policy.stopMicTrackOnMute,
    },
  };
}

export function getInteractiveRoomMediaOptions(): RoomOptions {
  return getInteractiveRoomMediaOptionsForEnvironment(getPlatformEnvironment());
}

export function getCameraPreviewTrackOptions(
  deviceId?: string,
): CreateLocalTracksOptions {
  return {
    video: getCameraCaptureOptions(deviceId),
    audio: false,
  };
}

/**
 * `withSound` is the presenter's choice; it is asked for only where the
 * browser can capture it, and then offers the system's sound too where the
 * platform has it (a whole screen on Windows or ChromeOS).
 */
export function getScreenShareCaptureOptionsForEnvironment(
  env: BrowserMediaEnvironment,
  withSound = true,
): ScreenShareCaptureOptions {
  const audio = withSound && canCaptureDisplayAudio(env);
  return {
    audio,
    ...(audio ? { systemAudio: "include" as const } : {}),
    video: true,
    contentHint: "detail",
    ...(supportsHighResDisplayCapture(env)
      ? { resolution: VideoPresets.h1080.resolution }
      : {}),
  };
}

export function getScreenShareCaptureOptions(): ScreenShareCaptureOptions {
  return getScreenShareCaptureOptionsForEnvironment(getPlatformEnvironment(), loadShareScreenSound());
}
