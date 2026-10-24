import { DEFAULT_SPEECH_LANGUAGE, normalizeSpeechLanguage } from "@orbmeet/caption-protocol";

/**
 * The language for a Deepgram stream: the shared caption-protocol
 * normalization with the agent's contract that a stream always receives a
 * tag, substituting `en-US` when nothing maps.
 */
export function normalizeLanguage(value: string | undefined): string {
  return normalizeSpeechLanguage(value, DEFAULT_SPEECH_LANGUAGE);
}
