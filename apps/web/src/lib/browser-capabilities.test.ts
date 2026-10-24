import { describe, expect, it } from "vitest";
import {
  canCaptureDisplay,
  canCaptureDisplayAudio,
  describeUserAgent,
  detectEngine,
  detectOS,
  hasUnreliableCoalescedPointerEvents,
  hasVoiceProcessingPlaybackBug,
  installsViaShareSheet,
  isAppleTouchDevice,
  isHandset,
  prefersLowRasterMemory,
  prefersMobileCaptureProfile,
  supportsHighResDisplayCapture,
  type PlatformEnvironment,
} from "./browser-capabilities";

// Real user agents. Note that `safariIPadDesktop` and `safariMac` are
// byte-identical: since iPadOS 13 Safari requests desktop sites by default, and
// touch support is the only thing that tells them apart.
const IPAD_DESKTOP_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";

const ENV = {
  safariIPhone: {
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    maxTouchPoints: 5,
  },
  safariIPadDesktop: { userAgent: IPAD_DESKTOP_UA, maxTouchPoints: 5 },
  safariIPadMobile: {
    userAgent:
      "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    maxTouchPoints: 5,
  },
  chromeIPad: {
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.108 Version/17.0 Safari/605.1.15",
    maxTouchPoints: 5,
  },
  safariMac: { userAgent: IPAD_DESKTOP_UA, maxTouchPoints: 0 },
  chromeMac: {
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    uaDataPlatform: "macOS",
    maxTouchPoints: 0,
  },
  firefoxMac: {
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:127.0) Gecko/20100101 Firefox/127.0",
    maxTouchPoints: 0,
  },
  chromeWindows: {
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    uaDataPlatform: "Windows",
    maxTouchPoints: 0,
  },
  chromeAndroid: {
    userAgent:
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
    uaDataPlatform: "Android",
    maxTouchPoints: 5,
  },
} satisfies Record<string, PlatformEnvironment>;

describe("detectOS", () => {
  it("identifies a desktop-mode iPad despite its Macintosh user agent", () => {
    expect(detectOS(ENV.safariIPadDesktop)).toBe("ipados");
    expect(detectOS(ENV.chromeIPad)).toBe("ipados");
  });

  it("does not mistake a real Mac for an iPad", () => {
    // Same UA bytes as safariIPadDesktop; only maxTouchPoints differs.
    expect(detectOS(ENV.safariMac)).toBe("macos");
    expect(detectOS(ENV.chromeMac)).toBe("macos");
  });

  it("identifies the remaining platforms", () => {
    expect(detectOS(ENV.safariIPhone)).toBe("ios");
    expect(detectOS(ENV.safariIPadMobile)).toBe("ipados");
    expect(detectOS(ENV.chromeWindows)).toBe("windows");
    expect(detectOS(ENV.chromeAndroid)).toBe("android");
    expect(detectOS(ENV.firefoxMac)).toBe("macos");
    expect(detectOS({})).toBe("unknown");
  });
});

describe("detectEngine", () => {
  it("reports WebKit for every browser on an Apple touch device", () => {
    expect(detectEngine(ENV.safariIPhone)).toBe("webkit");
    expect(detectEngine(ENV.safariIPadDesktop)).toBe("webkit");
    // Chrome on iPad brands itself Chromium but is WebKit underneath.
    expect(detectEngine(ENV.chromeIPad)).toBe("webkit");
  });

  it("distinguishes the desktop engines", () => {
    expect(detectEngine(ENV.safariMac)).toBe("webkit");
    expect(detectEngine(ENV.chromeMac)).toBe("chromium");
    expect(detectEngine(ENV.firefoxMac)).toBe("gecko");
    expect(detectEngine(ENV.chromeWindows)).toBe("chromium");
    expect(detectEngine(ENV.chromeAndroid)).toBe("chromium");
  });
});

describe("isAppleTouchDevice / isHandset", () => {
  it("counts the iPad as an Apple touch device but not as a handset", () => {
    expect(isAppleTouchDevice(ENV.safariIPadDesktop)).toBe(true);
    expect(isHandset(ENV.safariIPadDesktop)).toBe(false);
  });

  it("counts phones as both", () => {
    expect(isAppleTouchDevice(ENV.safariIPhone)).toBe(true);
    expect(isHandset(ENV.safariIPhone)).toBe(true);
    expect(isHandset(ENV.chromeAndroid)).toBe(true);
    expect(isAppleTouchDevice(ENV.chromeAndroid)).toBe(false);
  });
});

describe("canCaptureDisplay", () => {
  it("is false on iPad — the bug that left iPad users with a silent failure", () => {
    expect(canCaptureDisplay(ENV.safariIPadDesktop)).toBe(false);
    expect(canCaptureDisplay(ENV.safariIPhone)).toBe(false);
  });

  it("is true on desktop", () => {
    expect(canCaptureDisplay(ENV.safariMac)).toBe(true);
    expect(canCaptureDisplay(ENV.chromeWindows)).toBe(true);
    expect(canCaptureDisplay(ENV.firefoxMac)).toBe(true);
  });
});

describe("canCaptureDisplayAudio", () => {
  it("is false on Chrome for iPad, which reports as Chromium but is WebKit", () => {
    expect(canCaptureDisplayAudio(ENV.chromeIPad)).toBe(false);
  });

  it("is false where the request throws or is unsupported", () => {
    expect(canCaptureDisplayAudio(ENV.chromeAndroid)).toBe(false);
    expect(canCaptureDisplayAudio(ENV.safariMac)).toBe(false);
    expect(canCaptureDisplayAudio(ENV.firefoxMac)).toBe(false);
  });

  it("is true only on desktop Chromium", () => {
    expect(canCaptureDisplayAudio(ENV.chromeMac)).toBe(true);
    expect(canCaptureDisplayAudio(ENV.chromeWindows)).toBe(true);
  });
});

describe("capture profiles", () => {
  it("keeps the iPad on the desktop profile — it has the encoder headroom", () => {
    expect(prefersMobileCaptureProfile(ENV.safariIPadDesktop)).toBe(false);
    expect(prefersMobileCaptureProfile(ENV.safariIPhone)).toBe(true);
    expect(prefersMobileCaptureProfile(ENV.chromeAndroid)).toBe(true);
    expect(prefersMobileCaptureProfile(ENV.chromeMac)).toBe(false);
  });

  it("still throttles raster memory on iPad — WebKit's canvas ceiling is the constraint, not CPU", () => {
    expect(prefersLowRasterMemory(ENV.safariIPadDesktop)).toBe(true);
    expect(prefersLowRasterMemory(ENV.safariIPhone)).toBe(true);
    expect(prefersLowRasterMemory(ENV.chromeAndroid)).toBe(true);
    expect(prefersLowRasterMemory(ENV.chromeMac)).toBe(false);
  });
});

describe("WebKit behavioural quirks", () => {
  it("applies the voice-processing workaround to all WebKit, including macOS Safari", () => {
    expect(hasVoiceProcessingPlaybackBug(ENV.safariMac)).toBe(true);
    expect(hasVoiceProcessingPlaybackBug(ENV.safariIPhone)).toBe(true);
    expect(hasVoiceProcessingPlaybackBug(ENV.safariIPadDesktop)).toBe(true);
    expect(hasVoiceProcessingPlaybackBug(ENV.chromeIPad)).toBe(true);
    expect(hasVoiceProcessingPlaybackBug(ENV.chromeMac)).toBe(false);
    expect(hasVoiceProcessingPlaybackBug(ENV.firefoxMac)).toBe(false);
  });

  it("skips 1080p display capture on WebKit only", () => {
    expect(supportsHighResDisplayCapture(ENV.safariMac)).toBe(false);
    expect(supportsHighResDisplayCapture(ENV.chromeMac)).toBe(true);
    expect(supportsHighResDisplayCapture(ENV.firefoxMac)).toBe(true);
  });

  it("disables coalesced pointer events on Apple touch devices, iPad included", () => {
    expect(hasUnreliableCoalescedPointerEvents(ENV.safariIPadDesktop)).toBe(true);
    expect(hasUnreliableCoalescedPointerEvents(ENV.safariMac)).toBe(false);
  });
});

describe("installsViaShareSheet", () => {
  it("includes the iPad, which previously never saw the install hint", () => {
    expect(installsViaShareSheet(ENV.safariIPadDesktop)).toBe(true);
    expect(installsViaShareSheet(ENV.safariIPhone)).toBe(true);
    expect(installsViaShareSheet(ENV.chromeMac)).toBe(false);
  });
});

describe("describeUserAgent", () => {
  it("labels stored session user agents", () => {
    expect(describeUserAgent(ENV.chromeWindows.userAgent)).toBe("Chrome on Windows");
    expect(describeUserAgent(ENV.firefoxMac.userAgent)).toBe("Firefox on macOS");
    expect(describeUserAgent(ENV.safariIPhone.userAgent)).toBe("Safari on iOS");
    expect(describeUserAgent(ENV.chromeAndroid.userAgent)).toBe("Chrome on Android");
    expect(describeUserAgent(null)).toBe("Unknown device");
  });

  it("does not confuse Edge or Chrome-on-iOS with plain Chrome", () => {
    expect(
      describeUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0",
      ),
    ).toBe("Edge on Windows");
    expect(describeUserAgent(ENV.chromeIPad.userAgent)).toBe("Chrome on macOS");
  });
});
