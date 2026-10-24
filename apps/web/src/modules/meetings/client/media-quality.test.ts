import { describe, expect, it } from "vitest";

import { AudioPresets } from "livekit-client";
import {
  AUDIO_CAPTURE_DEFAULTS,
  AUDIO_PUBLISH_OPTIONS,
  DESKTOP_CAMERA_PUBLISH_OPTIONS,
  INTERACTIVE_ROOM_MEDIA_OPTIONS,
  MOBILE_CAMERA_PUBLISH_OPTIONS,
  SCREEN_SHARE_AUDIO_PUBLISH_OPTIONS,
  getAudioCaptureOptions,
  getCameraCaptureOptionsForEnvironment,
  getInteractiveRoomMediaOptionsForEnvironment,
  getCameraPublishOptionsForEnvironment,
  getScreenShareCaptureOptionsForEnvironment,
  isWebKitEnvironment,
} from "./media-quality";

const UA = {
  chromeWindows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
  chromeLinux:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
  safariMac:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  safariIOS:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Mobile/15E148 Safari/604.1",
  safariIPad:
    "Mozilla/5.0 (iPad; CPU OS 18_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Mobile/15E148 Safari/604.1",
  chromeAndroid:
    "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Mobile Safari/537.36",
  chromeIOS:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/136.0.0.0 Mobile/15E148 Safari/604.1",
  firefoxMac:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:150.0) Gecko/20100101 Firefox/150.0",
};

// An iPad in its default desktop mode sends a Macintosh user agent that is
// byte-identical to macOS Safari's; only maxTouchPoints separates them.
const IPAD_DESKTOP = { userAgent: UA.safariMac, maxTouchPoints: 5 };
const MAC_DESKTOP = { userAgent: UA.safariMac, maxTouchPoints: 0 };

describe("audio publish defaults", () => {
  it("publishes mic as 48 kbps mono Opus with RED and DTX enabled", () => {
    expect(AUDIO_PUBLISH_OPTIONS.audioPreset).toBe(AudioPresets.music);
    expect(AUDIO_PUBLISH_OPTIONS.red).toBe(true);
    expect(AUDIO_PUBLISH_OPTIONS.dtx).toBe(true);
    expect(AUDIO_PUBLISH_OPTIONS.forceStereo).toBe(false);
  });

  it("merges the audio defaults into the interactive room publishDefaults", () => {
    expect(INTERACTIVE_ROOM_MEDIA_OPTIONS.publishDefaults).toMatchObject({
      audioPreset: AudioPresets.music,
      red: true,
      dtx: true,
      forceStereo: false,
      videoCodec: "h264",
      simulcast: true,
    });
    expect(INTERACTIVE_ROOM_MEDIA_OPTIONS).toMatchObject({
      adaptiveStream: true,
      dynacast: true,
    });
  });

  it("uses native conferencing capture processing and preserves it with a selected device", () => {
    expect(AUDIO_CAPTURE_DEFAULTS).toEqual({
      autoGainControl: true,
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      voiceIsolation: true,
    });
    expect(getAudioCaptureOptions("mic-1")).toEqual({
      ...AUDIO_CAPTURE_DEFAULTS,
      deviceId: "mic-1",
    });
    expect(INTERACTIVE_ROOM_MEDIA_OPTIONS.audioCaptureDefaults).toEqual(
      AUDIO_CAPTURE_DEFAULTS,
    );
  });

  it("stops the mic track on mute only for Safari/iOS", () => {
    // A muted-but-live capture session keeps iPadOS in the degraded
    // voice-processing playback route; stopping the track restores the
    // media route while muted.
    for (const userAgent of [UA.safariMac, UA.safariIOS, UA.safariIPad, UA.chromeIOS]) {
      const options = getInteractiveRoomMediaOptionsForEnvironment({ userAgent });
      expect(options.publishDefaults?.stopMicTrackOnMute).toBe(true);
    }
    for (const userAgent of [UA.chromeWindows, UA.chromeAndroid, UA.firefoxMac]) {
      const options = getInteractiveRoomMediaOptionsForEnvironment({ userAgent });
      expect(options.publishDefaults?.stopMicTrackOnMute).toBe(false);
    }
  });
});

describe("camera adaptation", () => {
  it("publishes three layers on desktop and two on mobile", () => {
    expect(DESKTOP_CAMERA_PUBLISH_OPTIONS.videoSimulcastLayers).toHaveLength(2);
    expect(MOBILE_CAMERA_PUBLISH_OPTIONS.videoSimulcastLayers).toHaveLength(1);
    expect(
      getCameraPublishOptionsForEnvironment({ userAgent: UA.chromeAndroid }),
    ).toBe(MOBILE_CAMERA_PUBLISH_OPTIONS);
    expect(
      getCameraPublishOptionsForEnvironment({ userAgent: UA.chromeWindows }),
    ).toBe(DESKTOP_CAMERA_PUBLISH_OPTIONS);
  });

  it("captures a phone at 540p in its front camera's 4:3, and keeps 720p on desktop", () => {
    expect(
      getCameraCaptureOptionsForEnvironment({ userAgent: UA.safariIOS }),
    ).toMatchObject({ resolution: { width: 720, height: 540, aspectRatio: 4 / 3 } });
    expect(
      getCameraCaptureOptionsForEnvironment({ userAgent: UA.chromeWindows }),
    ).toMatchObject({ resolution: { width: 1280, height: 720 } });
  });
});

describe("screen-share audio publish options", () => {
  it("uses the music preset with RED on and DTX off", () => {
    expect(SCREEN_SHARE_AUDIO_PUBLISH_OPTIONS.audioPreset).toBe(AudioPresets.music);
    expect(SCREEN_SHARE_AUDIO_PUBLISH_OPTIONS.red).toBe(true);
    expect(SCREEN_SHARE_AUDIO_PUBLISH_OPTIONS.dtx).toBe(false);
  });
});

describe("getScreenShareCaptureOptionsForEnvironment", () => {
  it("requests browser audio on Chromium desktop", () => {
    const options = getScreenShareCaptureOptionsForEnvironment({
      userAgent: UA.chromeWindows,
    });

    expect(options.audio).toBe(true);
    expect(options.video).toBe(true);
    expect(options.contentHint).toBe("detail");
    expect(options.resolution).toMatchObject({ width: 1920, height: 1080 });
  });

  it("leaves the sound out when the presenter turned it off", () => {
    const options = getScreenShareCaptureOptionsForEnvironment({ userAgent: UA.chromeWindows }, false);

    expect(options.audio).toBe(false);
    expect(options).not.toHaveProperty("systemAudio");
  });

  it("does not request browser audio on Safari", () => {
    const options = getScreenShareCaptureOptionsForEnvironment({
      userAgent: UA.safariMac,
    });

    expect(options.audio).toBe(false);
    expect(options.video).toBe(true);
    expect(options.contentHint).toBe("detail");
    expect(options).not.toHaveProperty("resolution");
  });

  it("does not request browser audio on iOS Chromium", () => {
    const options = getScreenShareCaptureOptionsForEnvironment({
      userAgent: UA.chromeIOS,
    });

    expect(options.audio).toBe(false);
    expect(options.video).toBe(true);
    expect(options.contentHint).toBe("detail");
    expect(options).not.toHaveProperty("resolution");
  });

  it("does not request browser audio on Android Chrome", () => {
    const options = getScreenShareCaptureOptionsForEnvironment({
      userAgent: UA.chromeAndroid,
    });

    expect(options.audio).toBe(false);
    expect(options.video).toBe(true);
    expect(options.contentHint).toBe("detail");
    expect(options.resolution).toMatchObject({ width: 1920, height: 1080 });
  });
});

describe("isWebKitEnvironment", () => {
  it("matches Safari macOS, iOS, and iPad", () => {
    expect(isWebKitEnvironment({ userAgent: UA.safariMac })).toBe(true);
    expect(isWebKitEnvironment({ userAgent: UA.safariIOS })).toBe(true);
    expect(isWebKitEnvironment({ userAgent: UA.safariIPad })).toBe(true);
    expect(isWebKitEnvironment(IPAD_DESKTOP)).toBe(true);
    // Chrome on iOS is still WebKit under the hood — treat it the same.
    expect(isWebKitEnvironment({ userAgent: UA.chromeIOS })).toBe(true);
  });

  it("does not match Chrome/Firefox on desktop", () => {
    expect(isWebKitEnvironment({ userAgent: UA.chromeWindows })).toBe(false);
    expect(isWebKitEnvironment({ userAgent: UA.firefoxMac })).toBe(false);
  });
});

describe("desktop-mode iPad", () => {
  it("keeps the desktop camera profile — an iPad has the encoder headroom", () => {
    expect(getCameraPublishOptionsForEnvironment(IPAD_DESKTOP)).toBe(
      DESKTOP_CAMERA_PUBLISH_OPTIONS,
    );
  });

  it("declines screen-share audio and 1080p, exactly as it does on iPhone", () => {
    const options = getScreenShareCaptureOptionsForEnvironment(IPAD_DESKTOP);
    expect(options.audio).toBe(false);
    expect(options).not.toHaveProperty("resolution");
  });

  it("does not drag a real Mac along with it", () => {
    const options = getScreenShareCaptureOptionsForEnvironment({
      ...MAC_DESKTOP,
      userAgent: UA.chromeWindows,
    });
    expect(options.audio).toBe(true);
  });
});
