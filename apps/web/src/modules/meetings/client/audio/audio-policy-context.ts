import { getPlatformEnvironment, type PlatformEnvironment } from "@/lib/browser-capabilities";
import {
  readAudioPolicyOverrides,
  resolveAudioPolicy,
  type AudioPolicy,
  type AudioPolicyOverrides,
} from "./audio-policy";

export type { AudioPolicy };

/**
 * Binds the pure policy resolver to this page.
 *
 * Only the override parse is memoised. The policy itself is always derived from
 * the environment the caller is asking about, so a function that receives a
 * `PlatformEnvironment` can never disagree with the policy applied alongside
 * it — the environment is the input, not an ambient global.
 */
let cachedOverrides: AudioPolicyOverrides | null = null;

function getActiveAudioPolicyOverrides(): AudioPolicyOverrides {
  if (typeof window === "undefined") return {};
  if (!cachedOverrides) {
    cachedOverrides = readAudioPolicyOverrides(window.location.search);
  }
  return cachedOverrides;
}

export function getAudioPolicyForEnvironment(env: PlatformEnvironment): AudioPolicy {
  return resolveAudioPolicy(env, getActiveAudioPolicyOverrides());
}

export function getActiveAudioPolicy(): AudioPolicy {
  return getAudioPolicyForEnvironment(getPlatformEnvironment());
}
