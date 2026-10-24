/**
 * Platform and capability detection.
 *
 * Callers should ask what a device *can do* (`canCaptureDisplay`), not who it
 * *is* (`isIOS`). The identity predicates exist because a handful of questions
 * genuinely have no feature test — WebKit's voice-processing playback bug and
 * its unreliable coalesced pointer events are behavioural, not detectable — but
 * every such question is named after the behaviour it gates.
 *
 * The one hard case this module exists to get right: since iPadOS 13, Safari
 * requests desktop sites by default and reports a `Macintosh` user agent with
 * no `iPad` token. Its UA is byte-identical to macOS Safari's. The *only*
 * discriminator is touch support, so every entry point threads `maxTouchPoints`
 * through. A bare `/iPad|iPhone|iPod/` test misses every modern iPad, which is
 * how the same bug shipped in five separate places.
 */

export type OS =
  | "android"
  | "ios"
  | "ipados"
  | "linux"
  | "macos"
  | "windows"
  | "unknown";

/** The rendering engine, which is not always what the browser brand suggests. */
export type Engine = "chromium" | "gecko" | "webkit" | "unknown";

export interface PlatformEnvironment {
  userAgent?: string;
  /** `navigator.userAgentData.platform` — Chromium-only, and trustworthy where present. */
  uaDataPlatform?: string;
  maxTouchPoints?: number;
}

/** Snapshot the live browser. Returns an empty environment off the main thread or on the server. */
export function getPlatformEnvironment(): PlatformEnvironment {
  if (typeof navigator === "undefined") return {};
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  return {
    userAgent: navigator.userAgent,
    uaDataPlatform: nav.userAgentData?.platform,
    maxTouchPoints: navigator.maxTouchPoints,
  };
}

// No touchscreen Mac exists, so a touch-capable "Macintosh" is a desktop-mode
// iPad. Trackpads and some peripherals report 1, so require more than one.
function isTouchCapable(env: PlatformEnvironment): boolean {
  return (env.maxTouchPoints ?? 0) > 1;
}

export function detectOS(env: PlatformEnvironment): OS {
  const ua = env.userAgent ?? "";

  // Apple never ships userAgentData, so a claim of "macOS" here is always a
  // real Mac and can be trusted without the touch check.
  switch (env.uaDataPlatform?.toLowerCase()) {
    case "android":
      return "android";
    case "chrome os":
    case "chromeos":
    case "linux":
      return "linux";
    case "macos":
      return "macos";
    case "windows":
      return "windows";
  }

  if (/iphone|ipod/i.test(ua)) return "ios";
  if (/ipad/i.test(ua)) return "ipados";
  if (/\bMac\b|Macintosh/i.test(ua)) {
    return isTouchCapable(env) ? "ipados" : "macos";
  }
  if (/android/i.test(ua)) return "android";
  if (/windows/i.test(ua)) return "windows";
  if (/linux|x11/i.test(ua)) return "linux";
  return "unknown";
}

export function detectEngine(env: PlatformEnvironment): Engine {
  const ua = env.userAgent ?? "";

  // Every browser on iOS/iPadOS is WebKit underneath, whatever it brands
  // itself as — Chrome (CriOS), Edge (EdgiOS) and Firefox (FxiOS) included.
  if (isAppleTouchDevice(env)) return "webkit";

  if (/firefox|fxios|\bgecko\//i.test(ua)) return "gecko";
  if (/edg|chrome|chromium|\bopr\//i.test(ua)) return "chromium";
  if (/safari/i.test(ua)) return "webkit";
  return "unknown";
}

/**
 * iPhone, iPod or iPad — including an iPad in its default desktop mode, which
 * is the case naive UA tests miss.
 */
export function isAppleTouchDevice(env: PlatformEnvironment): boolean {
  const os = detectOS(env);
  return os === "ios" || os === "ipados";
}

/**
 * A phone-class device that should not be asked to run several encoders at
 * desktop resolutions. Deliberately excludes iPad, which has the headroom.
 */
export function isHandset(env: PlatformEnvironment): boolean {
  const os = detectOS(env);
  return os === "ios" || os === "android";
}

// ---------------------------------------------------------------------------
// Capabilities — prefer these at call sites.
// ---------------------------------------------------------------------------

/**
 * Whether `getDisplayMedia` can capture anything worth publishing. iOS and
 * iPadOS offer no useful full-screen path: the request is auto-rejected or the
 * user dismisses the picker, both surfacing as an indistinguishable
 * `NotAllowedError`, so callers must check this up front to say anything useful.
 */
export function canCaptureDisplay(env: PlatformEnvironment): boolean {
  return !isAppleTouchDevice(env);
}

/**
 * Whether `getDisplayMedia` may be asked for audio. Only Chromium offers it,
 * Android Chrome throws `NotSupportedError` when asked, and an iPad running
 * Chrome reports as Chromium while being WebKit — so it must be excluded
 * explicitly or the request throws there too.
 */
export function canCaptureDisplayAudio(env: PlatformEnvironment): boolean {
  if (isAppleTouchDevice(env)) return false;
  if (detectOS(env) === "android") return false;
  return detectEngine(env) === "chromium";
}

/** Handsets get a lower capture resolution and a shallower simulcast ladder. */
export function prefersMobileCaptureProfile(env: PlatformEnvironment): boolean {
  return isHandset(env);
}

/**
 * Whether to raster large whiteboards at reduced pixel ratios. WebKit on touch
 * devices enforces a canvas memory ceiling far below the desktop limit, and
 * exceeding it fails the export outright rather than degrading it.
 */
export function prefersLowRasterMemory(env: PlatformEnvironment): boolean {
  return isHandset(env) || isAppleTouchDevice(env);
}

/**
 * WebKit routes the entire audio session through OS voice processing while a
 * mic track captures, degrading speaker playback (and on iPadOS 27 beta,
 * emitting intermittent bursts on the built-in route). Callers stop the mic
 * track on mute to fall back to the clean media route.
 */
export function hasVoiceProcessingPlaybackBug(env: PlatformEnvironment): boolean {
  return detectEngine(env) === "webkit";
}

/** WebKit screen capture is unreliable above 720p; skip the 1080p request. */
export function supportsHighResDisplayCapture(env: PlatformEnvironment): boolean {
  return detectEngine(env) !== "webkit";
}

/**
 * WebKit on Apple Pencil occasionally includes a stale point far from the real
 * stroke in `PointerEvent.getCoalescedEvents()`, which fuses to the shape as a
 * long straight tail.
 */
export function hasUnreliableCoalescedPointerEvents(env: PlatformEnvironment): boolean {
  return isAppleTouchDevice(env);
}

export function getWhiteboardClientCapabilities(
  env: PlatformEnvironment = getPlatformEnvironment(),
) {
  return {
    reduceRasterMemory: prefersLowRasterMemory(env),
    disableCoalescedPointerEvents: hasUnreliableCoalescedPointerEvents(env),
  };
}

/** Apple withholds `beforeinstallprompt`; installing means Share → Add to Home Screen. */
export function installsViaShareSheet(env: PlatformEnvironment): boolean {
  return isAppleTouchDevice(env);
}

/** True when the page is running as an installed app rather than a browser tab. */
export function isStandaloneDisplayMode(): boolean {
  if (typeof window === "undefined") return false;
  const legacyStandalone = (navigator as Navigator & { standalone?: boolean }).standalone;
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    legacyStandalone === true
  );
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

const OS_LABELS: Record<OS, string> = {
  android: "Android",
  ios: "iOS",
  ipados: "iPadOS",
  linux: "Linux",
  macos: "macOS",
  windows: "Windows",
  unknown: "Unknown OS",
};

/**
 * Human-readable label for a *stored* user agent — a login session record, say.
 * `maxTouchPoints` is unavailable for a past request, so a desktop-mode iPad is
 * indistinguishable from a Mac here and will read as macOS. That is a real
 * limit of the recorded data, not a detection bug.
 */
export function describeUserAgent(userAgent: string | null | undefined): string {
  if (!userAgent) return "Unknown device";
  const env: PlatformEnvironment = { userAgent };

  const brand = /\bedg/i.test(userAgent)
    ? "Edge"
    : /\bopr\/|opera/i.test(userAgent)
      ? "Opera"
      : /firefox|fxios/i.test(userAgent)
        ? "Firefox"
        : /chrome|crios|chromium/i.test(userAgent)
          ? "Chrome"
          : /safari/i.test(userAgent)
            ? "Safari"
            : "Unknown browser";

  return `${brand} on ${OS_LABELS[detectOS(env)]}`;
}
