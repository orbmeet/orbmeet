import {
  detectEngine,
  detectOS,
  hasVoiceProcessingPlaybackBug,
  isAppleTouchDevice,
  type PlatformEnvironment,
} from "@/lib/browser-capabilities";

/**
 * Every platform-conditional audio decision, in one table.
 *
 * These choices interact — echo cancellation selects the capture route, the
 * capture route decides how loud remote audio plays on iOS, and stopping the
 * track on mute flips that route mid-call — so deciding them at separate call
 * sites made the resulting behaviour impossible to reason about or to test
 * without the device in hand. Resolving them together, with the reason
 * attached, makes iPadOS legible from a diagnostic payload.
 */

/** Values WebKit accepts for `navigator.audioSession.type`. */
export type AudioSessionType =
  | "auto"
  | "playback"
  | "transient"
  | "transient-solo"
  | "ambient"
  | "play-and-record";

export interface AudioPolicy {
  /**
   * Stop the capture track while muted. Clears the OS recording indicator, and
   * on WebKit returns playback to the media route for the duration of the mute.
   */
  stopMicTrackOnMute: boolean;
  /**
   * Browser echo cancellation. On WebKit this is the switch that engages the
   * voice-processing audio unit — the unit whose playback attenuation is the
   * bug `hasVoiceProcessingPlaybackBug` names.
   */
  echoCancellation: boolean;
  /** Declared to WebKit, or null to leave the engine's own choice alone. */
  audioSessionType: AudioSessionType | null;
  /** Warm the microphone before LiveKit opens its own capture. */
  warmCaptureBeforeJoin: boolean;
  /** Why each non-default choice was made, for diagnostics and triage. */
  reasons: string[];
}

/**
 * Field overrides, so the iPadOS route can be A/B tested on a real device
 * without a rebuild. Read from the query string:
 *
 *   ?aec=off                 — drop echo cancellation (loud playback, echoes)
 *   ?audioSession=playback   — declare a session type explicitly
 *   ?stopOnMute=off          — keep capture alive while muted
 */
export interface AudioPolicyOverrides {
  echoCancellation?: boolean;
  audioSessionType?: AudioSessionType | null;
  stopMicTrackOnMute?: boolean;
}

const AUDIO_SESSION_TYPES: readonly AudioSessionType[] = [
  "auto",
  "playback",
  "transient",
  "transient-solo",
  "ambient",
  "play-and-record",
];

function parseBoolean(value: string | null): boolean | undefined {
  if (value === "on" || value === "true" || value === "1") return true;
  if (value === "off" || value === "false" || value === "0") return false;
  return undefined;
}

export function readAudioPolicyOverrides(search: string): AudioPolicyOverrides {
  const params = new URLSearchParams(search);
  const overrides: AudioPolicyOverrides = {};

  const echoCancellation = parseBoolean(params.get("aec"));
  if (echoCancellation !== undefined) overrides.echoCancellation = echoCancellation;

  const stopOnMute = parseBoolean(params.get("stopOnMute"));
  if (stopOnMute !== undefined) overrides.stopMicTrackOnMute = stopOnMute;

  const audioSession = params.get("audioSession");
  if (audioSession === "off") {
    overrides.audioSessionType = null;
  } else if (AUDIO_SESSION_TYPES.includes(audioSession as AudioSessionType)) {
    overrides.audioSessionType = audioSession as AudioSessionType;
  }

  return overrides;
}

export function resolveAudioPolicy(
  env: PlatformEnvironment,
  overrides: AudioPolicyOverrides = {},
): AudioPolicy {
  const reasons: string[] = [];
  const webkitPlaybackBug = hasVoiceProcessingPlaybackBug(env);

  let stopMicTrackOnMute = false;
  if (webkitPlaybackBug) {
    stopMicTrackOnMute = true;
    reasons.push(
      "webkit: stop capture on mute so playback returns to the media route while muted",
    );
  }

  // Echo cancellation stays on by default everywhere: without it, anyone on
  // speakers echoes into the meeting. It is the most promising lever for the
  // WebKit playback attenuation, which is why it is overridable.
  let echoCancellation = true;

  // Declaring the session type is only meaningful where the engine implements
  // it, and `play-and-record` is what a conference actually does: it keeps
  // WebKit from re-deciding the route each time capture starts and stops.
  let audioSessionType: AudioSessionType | null = null;
  if (isAppleTouchDevice(env)) {
    audioSessionType = "play-and-record";
    reasons.push("ios/ipados: declare a stable play-and-record session");
  }

  // The macOS warmup exists to keep LiveKit's first capture from being a cold
  // start, which can wake Continuity Camera on a nearby iPhone.
  const warmCaptureBeforeJoin = detectOS(env) === "macos";
  if (warmCaptureBeforeJoin) {
    reasons.push("macos: warm capture to avoid a Continuity Camera handoff");
  }

  if (overrides.echoCancellation !== undefined) {
    echoCancellation = overrides.echoCancellation;
    reasons.push(`override: echoCancellation=${echoCancellation}`);
  }
  if (overrides.stopMicTrackOnMute !== undefined) {
    stopMicTrackOnMute = overrides.stopMicTrackOnMute;
    reasons.push(`override: stopMicTrackOnMute=${stopMicTrackOnMute}`);
  }
  if (overrides.audioSessionType !== undefined) {
    audioSessionType = overrides.audioSessionType;
    reasons.push(`override: audioSessionType=${audioSessionType ?? "none"}`);
  }

  return {
    stopMicTrackOnMute,
    echoCancellation,
    audioSessionType,
    warmCaptureBeforeJoin,
    reasons,
  };
}

interface AudioSessionCapableNavigator extends Navigator {
  audioSession?: { type?: string };
}

/**
 * Declares the page's audio session type where WebKit supports it. Returns what
 * happened so the caller can record it — on iPadOS this is the difference
 * between "we asked and it stuck" and "the engine ignored us", which is
 * otherwise invisible from outside the device.
 */
export function applyAudioSessionType(
  type: AudioSessionType | null,
): "applied" | "unsupported" | "skipped" | "failed" {
  if (!type) return "skipped";
  if (typeof navigator === "undefined") return "unsupported";

  const audioSession = (navigator as AudioSessionCapableNavigator).audioSession;
  if (!audioSession || typeof audioSession.type !== "string") return "unsupported";

  try {
    audioSession.type = type;
    return audioSession.type === type ? "applied" : "failed";
  } catch {
    return "failed";
  }
}

/** Compact, PII-free description of the resolved policy for diagnostics. */
export function describeAudioPolicy(
  env: PlatformEnvironment,
  policy: AudioPolicy,
): Record<string, unknown> {
  return {
    os: detectOS(env),
    engine: detectEngine(env),
    stopMicTrackOnMute: policy.stopMicTrackOnMute,
    echoCancellation: policy.echoCancellation,
    audioSessionType: policy.audioSessionType ?? "none",
    reasons: policy.reasons,
  };
}
