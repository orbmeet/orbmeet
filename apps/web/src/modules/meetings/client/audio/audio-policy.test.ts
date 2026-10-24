import { describe, expect, it } from "vitest";
import type { PlatformEnvironment } from "@/lib/browser-capabilities";
import {
  readAudioPolicyOverrides,
  resolveAudioPolicy,
} from "./audio-policy";

const CHROME_ON_WINDOWS: PlatformEnvironment = {
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
  uaDataPlatform: "Windows",
  maxTouchPoints: 0,
};

const SAFARI_ON_MACOS: PlatformEnvironment = {
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
  maxTouchPoints: 0,
};

// An iPad in its default desktop mode: byte-identical UA to macOS Safari, and
// only the touch points give it away.
const SAFARI_ON_IPADOS: PlatformEnvironment = {
  ...SAFARI_ON_MACOS,
  maxTouchPoints: 5,
};

describe("resolveAudioPolicy", () => {
  it("leaves non-WebKit platforms on the plain defaults", () => {
    const policy = resolveAudioPolicy(CHROME_ON_WINDOWS);

    expect(policy.stopMicTrackOnMute).toBe(false);
    expect(policy.echoCancellation).toBe(true);
    expect(policy.audioSessionType).toBeNull();
    expect(policy.warmCaptureBeforeJoin).toBe(false);
  });

  it("stops capture on mute for WebKit's playback bug", () => {
    const policy = resolveAudioPolicy(SAFARI_ON_MACOS);

    expect(policy.stopMicTrackOnMute).toBe(true);
    expect(policy.warmCaptureBeforeJoin).toBe(true);
    // Not an Apple *touch* device, so no session type is declared.
    expect(policy.audioSessionType).toBeNull();
  });

  it("declares a stable session type on iPadOS in desktop mode", () => {
    const policy = resolveAudioPolicy(SAFARI_ON_IPADOS);

    expect(policy.audioSessionType).toBe("play-and-record");
    expect(policy.stopMicTrackOnMute).toBe(true);
    expect(policy.reasons.join(" ")).toContain("ios/ipados");
  });

  it("records why each choice was made", () => {
    expect(resolveAudioPolicy(CHROME_ON_WINDOWS).reasons).toEqual([]);
    expect(resolveAudioPolicy(SAFARI_ON_IPADOS).reasons.length).toBeGreaterThan(0);
  });

  it("applies overrides and reports them", () => {
    const policy = resolveAudioPolicy(SAFARI_ON_IPADOS, {
      echoCancellation: false,
      audioSessionType: "playback",
    });

    expect(policy.echoCancellation).toBe(false);
    expect(policy.audioSessionType).toBe("playback");
    expect(policy.reasons).toContain("override: echoCancellation=false");
    expect(policy.reasons).toContain("override: audioSessionType=playback");
  });
});

describe("readAudioPolicyOverrides", () => {
  it("reads nothing from an empty query string", () => {
    expect(readAudioPolicyOverrides("")).toEqual({});
  });

  it("parses the device-testing switches", () => {
    expect(readAudioPolicyOverrides("?aec=off&stopOnMute=off&audioSession=playback")).toEqual({
      echoCancellation: false,
      stopMicTrackOnMute: false,
      audioSessionType: "playback",
    });
  });

  it("distinguishes disabling the session type from not specifying one", () => {
    expect(readAudioPolicyOverrides("?audioSession=off")).toEqual({
      audioSessionType: null,
    });
    expect(readAudioPolicyOverrides("?audioSession=nonsense")).toEqual({});
  });
});
