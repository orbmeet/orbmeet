/**
 * Source of truth for the speech language tags Orb Meet supports for live
 * transcription, and for the normalization semantics shared by the browser
 * caption picker (apps/web caption modules) and the transcription agent
 * (apps/transcription-agent).
 *
 * The tags are the Deepgram Nova-3 streaming transcription codes; keep this
 * list aligned with docs/deepgram/docs/models-languages-overview.md. Exactly
 * one canonical tag is exposed per useful dialect — browser-specific tags
 * that the transcription provider would reject are normalized here instead
 * of being passed through.
 *
 * Normalization is total and case-insensitive: an already-canonical tag maps
 * to itself, a recognized language (or region dialect) maps to its canonical
 * tag, and anything unrecognized maps to `null`. Callers choose the failure
 * mode: the browser surfaces `null` to the user, while the agent substitutes
 * `DEFAULT_SPEECH_LANGUAGE` via `normalizeSpeechLanguage`.
 *
 * Canonical decisions (the two former per-app implementations disagreed):
 * - Unknown input yields `null` (never a guessed language). Agents that need
 *   a non-null tag apply the fallback explicitly.
 * - Norwegian MacROLANG codes `nb`/`nn` (e.g. `nb-NO`) normalize to `no`,
 *   Deepgram's Norwegian tag.
 * - Chinese dialect subtags win over the script-and-base default: `zh-HK`,
 *   `zh_MO` → `zh-HK`; `zh-Hant`, `zh_TW` → `zh-TW`; any other `zh-*` →
 *   `zh-CN`. The bare bases `zh` and `yue` default to `zh-CN` and `zh-HK`.
 */

/** Every speech language tag the transcription provider accepts, in display order. */
export const SUPPORTED_SPEECH_LANGUAGE_TAGS = [
  "multi",
  "ar",
  "be",
  "bn",
  "bs",
  "bg",
  "ca",
  "zh-CN",
  "zh-TW",
  "zh-HK",
  "hr",
  "cs",
  "da-DK",
  "nl",
  "nl-BE",
  "en-US",
  "en-GB",
  "en-AU",
  "en-IN",
  "en-NZ",
  "et",
  "fi",
  "fr",
  "fr-CA",
  "de",
  "de-CH",
  "el",
  "gu-IN",
  "he",
  "hi",
  "hu",
  "id",
  "it",
  "ja",
  "kn",
  "ko-KR",
  "lv",
  "lt",
  "mk",
  "ms",
  "mr",
  "no",
  "fa",
  "pl",
  "pt-BR",
  "pt-PT",
  "ro",
  "ru",
  "sr",
  "sk",
  "sl",
  "es",
  "es-419",
  "sv-SE",
  "tl",
  "ta",
  "te",
  "th-TH",
  "tr",
  "uk",
  "ur",
  "vi",
] as const;

export type SpeechLanguageTag = (typeof SUPPORTED_SPEECH_LANGUAGE_TAGS)[number];

/** Language used when nothing better is known; Deepgram's default is en-US. */
export const DEFAULT_SPEECH_LANGUAGE: SpeechLanguageTag = "en-US";

const SUPPORTED_BY_LOWER_CASE = new Map<string, SpeechLanguageTag>(
  SUPPORTED_SPEECH_LANGUAGE_TAGS.map((tag) => [tag.toLowerCase(), tag]),
);

/** Canonical tag for a bare ISO language code (`en` → `en-US`, `yue` → `zh-HK`). */
const BASE_LANGUAGE_DEFAULTS: Readonly<Record<string, SpeechLanguageTag>> = {
  ar: "ar",
  be: "be",
  bg: "bg",
  bn: "bn",
  bs: "bs",
  ca: "ca",
  cs: "cs",
  da: "da-DK",
  de: "de",
  el: "el",
  en: "en-US",
  es: "es",
  et: "et",
  fa: "fa",
  fi: "fi",
  fil: "tl",
  fr: "fr",
  gu: "gu-IN",
  he: "he",
  hi: "hi",
  hr: "hr",
  hu: "hu",
  id: "id",
  it: "it",
  ja: "ja",
  kn: "kn",
  ko: "ko-KR",
  lt: "lt",
  lv: "lv",
  mk: "mk",
  mr: "mr",
  ms: "ms",
  nl: "nl",
  no: "no",
  pl: "pl",
  pt: "pt-BR",
  ro: "ro",
  ru: "ru",
  sk: "sk",
  sl: "sl",
  sr: "sr",
  sv: "sv-SE",
  ta: "ta",
  te: "te",
  th: "th-TH",
  tl: "tl",
  tr: "tr",
  uk: "uk",
  ur: "ur",
  vi: "vi",
  yue: "zh-HK",
  zh: "zh-CN",
};

export function isSupportedSpeechLanguageTag(value: string): value is SpeechLanguageTag {
  return (
    (SUPPORTED_SPEECH_LANGUAGE_TAGS as readonly string[]).includes(value) ||
    SUPPORTED_BY_LOWER_CASE.has(value.toLowerCase())
  );
}

/**
 * Normalize any human- or browser-provided language tag to a canonical
 * supported tag, or `null` when nothing maps. Handles exact and
 * case-insensitive matches, `_` region separators, Norwegian and Chinese
 * dialect families, and bare base languages.
 */
export function normalizeSpeechLanguageTag(
  value: string | null | undefined,
): SpeechLanguageTag | null {
  const language = value?.trim();
  if (!language) return null;
  const exact =
    SUPPORTED_BY_LOWER_CASE.get(language) ?? SUPPORTED_BY_LOWER_CASE.get(language.toLowerCase());
  if (exact) return exact;
  const parts = language.toLowerCase().replaceAll("_", "-").split("-");
  const base = parts[0] ?? "";
  if (base === "nb" || base === "nn") return "no";
  if (base === "zh") {
    if (parts.includes("hk") || parts.includes("mo")) return "zh-HK";
    if (parts.includes("hant") || parts.includes("tw")) return "zh-TW";
    return "zh-CN";
  }
  return BASE_LANGUAGE_DEFAULTS[base] ?? null;
}

/**
 * Like `normalizeSpeechLanguageTag`, but substitutes `fallback` (default
 * `DEFAULT_SPEECH_LANGUAGE`) instead of returning `null`. This is the
 * transcription agent's contract: a Deepgram stream always gets a tag.
 */
export function normalizeSpeechLanguage(
  value: string | null | undefined,
  fallback: string = DEFAULT_SPEECH_LANGUAGE,
): string {
  return normalizeSpeechLanguageTag(value) ?? fallback;
}
