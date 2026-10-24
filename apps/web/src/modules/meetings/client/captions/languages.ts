import {
  DEFAULT_SPEECH_LANGUAGE,
  normalizeSpeechLanguageTag,
  SUPPORTED_SPEECH_LANGUAGE_TAGS,
  type SpeechLanguageTag,
} from "@orbmeet/caption-protocol";

export { DEFAULT_SPEECH_LANGUAGE, normalizeSpeechLanguageTag };

export interface SpeechLanguageOption {
  label: string;
  tag: SpeechLanguageTag;
  regionLabel?: string;
  aliases?: string[];
}

/**
 * Display metadata for one row of the browser caption-language picker, keyed
 * by the canonical tag. The set and order of tags — and how free-form input
 * normalizes onto them — come from `@orbmeet/caption-protocol`, the shared
 * source of truth with the transcription agent; this map only describes how
 * each tag renders and searches in the web UI. The compiler rejects a
 * metadata map that misses or invents a supported tag.
 */
const SPEECH_LANGUAGE_PICKER_METADATA: Record<
  SpeechLanguageTag,
  Omit<SpeechLanguageOption, "tag">
> = {
  "multi": { label: "Multilingual", regionLabel: "Automatic language switching", aliases: ["auto", "code switching"] },
  "ar": { label: "العربية", regionLabel: "Arabic", aliases: ["arabic"] },
  "be": { label: "Беларуская", regionLabel: "Belarusian", aliases: ["belarusian"] },
  "bn": { label: "বাংলা", regionLabel: "Bengali", aliases: ["bangla", "bengali"] },
  "bs": { label: "Bosanski", regionLabel: "Bosnian", aliases: ["bosnian"] },
  "bg": { label: "Български", regionLabel: "Bulgarian", aliases: ["bulgarian"] },
  "ca": { label: "Català", regionLabel: "Catalan", aliases: ["catalan"] },
  "zh-CN": { label: "中文", regionLabel: "Mandarin, Simplified", aliases: ["chinese", "mandarin", "simplified"] },
  "zh-TW": { label: "中文", regionLabel: "Mandarin, Traditional", aliases: ["chinese", "mandarin", "traditional", "taiwan"] },
  "zh-HK": { label: "粵語", regionLabel: "Cantonese, Traditional", aliases: ["chinese", "cantonese", "hong kong"] },
  "hr": { label: "Hrvatski", regionLabel: "Croatian", aliases: ["croatian"] },
  "cs": { label: "Čeština", regionLabel: "Czech", aliases: ["czech"] },
  "da-DK": { label: "Dansk", regionLabel: "Danish", aliases: ["danish"] },
  "nl": { label: "Nederlands", regionLabel: "Dutch", aliases: ["dutch"] },
  "nl-BE": { label: "Nederlands", regionLabel: "Flemish", aliases: ["dutch", "flemish", "belgium"] },
  "en-US": { label: "English", regionLabel: "United States" },
  "en-GB": { label: "English", regionLabel: "United Kingdom" },
  "en-AU": { label: "English", regionLabel: "Australia" },
  "en-IN": { label: "English", regionLabel: "India" },
  "en-NZ": { label: "English", regionLabel: "New Zealand" },
  "et": { label: "Eesti", regionLabel: "Estonian", aliases: ["estonian"] },
  "fi": { label: "Suomi", regionLabel: "Finnish", aliases: ["finnish"] },
  "fr": { label: "Français", regionLabel: "French", aliases: ["french"] },
  "fr-CA": { label: "Français", regionLabel: "Canada", aliases: ["french", "canadian"] },
  "de": { label: "Deutsch", regionLabel: "German", aliases: ["german"] },
  "de-CH": { label: "Deutsch", regionLabel: "Switzerland", aliases: ["german", "swiss"] },
  "el": { label: "Ελληνικά", regionLabel: "Greek", aliases: ["greek"] },
  "gu-IN": { label: "ગુજરાતી", regionLabel: "Gujarati", aliases: ["gujarati"] },
  "he": { label: "עברית", regionLabel: "Hebrew", aliases: ["hebrew"] },
  "hi": { label: "हिन्दी", regionLabel: "Hindi", aliases: ["hindi"] },
  "hu": { label: "Magyar", regionLabel: "Hungarian", aliases: ["hungarian"] },
  "id": { label: "Bahasa Indonesia", regionLabel: "Indonesian", aliases: ["indonesian"] },
  "it": { label: "Italiano", regionLabel: "Italian", aliases: ["italian"] },
  "ja": { label: "日本語", regionLabel: "Japanese", aliases: ["japanese"] },
  "kn": { label: "ಕನ್ನಡ", regionLabel: "Kannada", aliases: ["kannada"] },
  "ko-KR": { label: "한국어", regionLabel: "Korean", aliases: ["korean"] },
  "lv": { label: "Latviešu", regionLabel: "Latvian", aliases: ["latvian"] },
  "lt": { label: "Lietuvių", regionLabel: "Lithuanian", aliases: ["lithuanian"] },
  "mk": { label: "Македонски", regionLabel: "Macedonian", aliases: ["macedonian"] },
  "ms": { label: "Bahasa Melayu", regionLabel: "Malay", aliases: ["malay"] },
  "mr": { label: "मराठी", regionLabel: "Marathi", aliases: ["marathi"] },
  "no": { label: "Norsk", regionLabel: "Norwegian", aliases: ["norwegian"] },
  "fa": { label: "فارسی", regionLabel: "Persian", aliases: ["persian", "farsi"] },
  "pl": { label: "Polski", regionLabel: "Polish", aliases: ["polish"] },
  "pt-BR": { label: "Português", regionLabel: "Brazil", aliases: ["portuguese"] },
  "pt-PT": { label: "Português", regionLabel: "Portugal", aliases: ["portuguese"] },
  "ro": { label: "Română", regionLabel: "Romanian", aliases: ["romanian"] },
  "ru": { label: "Русский", regionLabel: "Russian", aliases: ["russian"] },
  "sr": { label: "Српски", regionLabel: "Serbian", aliases: ["serbian"] },
  "sk": { label: "Slovenčina", regionLabel: "Slovak", aliases: ["slovak"] },
  "sl": { label: "Slovenščina", regionLabel: "Slovenian", aliases: ["slovenian"] },
  "es": { label: "Español", regionLabel: "Spain", aliases: ["spanish"] },
  "es-419": { label: "Español", regionLabel: "Latin America", aliases: ["spanish", "latam"] },
  "sv-SE": { label: "Svenska", regionLabel: "Swedish", aliases: ["swedish"] },
  "tl": { label: "Tagalog", regionLabel: "Filipino", aliases: ["filipino"] },
  "ta": { label: "தமிழ்", regionLabel: "Tamil", aliases: ["tamil"] },
  "te": { label: "తెలుగు", regionLabel: "Telugu", aliases: ["telugu"] },
  "th-TH": { label: "ภาษาไทย", regionLabel: "Thai", aliases: ["thai"] },
  "tr": { label: "Türkçe", regionLabel: "Turkish", aliases: ["turkish"] },
  "uk": { label: "Українська", regionLabel: "Ukrainian", aliases: ["ukrainian"] },
  "ur": { label: "اُردُو", regionLabel: "Urdu", aliases: ["urdu"] },
  "vi": { label: "Tiếng Việt", regionLabel: "Vietnamese", aliases: ["vietnamese"] },
};

export const SPEECH_LANGUAGE_OPTIONS: SpeechLanguageOption[] = SUPPORTED_SPEECH_LANGUAGE_TAGS
  .map((tag) => ({ tag, ...SPEECH_LANGUAGE_PICKER_METADATA[tag] }));

export const SPOKEN_LANGUAGE_STORAGE_KEY = "orbmeet.spoken-language.v1";

const COUNTRY_DEFAULT_LANGUAGE: Record<string, SpeechLanguageTag> = {
  US: "en-US", GB: "en-GB", IE: "en-GB", AU: "en-AU", CA: "en-US",
  NZ: "en-NZ", ZA: "en-US", PH: "tl", NG: "en-US", GH: "en-US", KE: "en-US",
  SG: "en-US", IN: "hi", BD: "bn", PK: "ur", LK: "ta", NP: "hi",
  CN: "zh-CN", HK: "zh-HK", MO: "zh-HK", TW: "zh-TW", JP: "ja", KR: "ko-KR",
  VN: "vi", TH: "th-TH", MY: "ms", ID: "id", ES: "es", MX: "es-419",
  AR: "es-419", CL: "es-419", CO: "es-419", PE: "es-419", BR: "pt-BR",
  PT: "pt-PT", FR: "fr", DE: "de", CH: "de-CH", IT: "it", NL: "nl",
  BE: "nl-BE", PL: "pl", RU: "ru", UA: "uk", CZ: "cs", SK: "sk", HU: "hu",
  RO: "ro", BG: "bg", GR: "el", HR: "hr", SI: "sl", RS: "sr", SE: "sv-SE",
  NO: "no", DK: "da-DK", FI: "fi", TR: "tr", IL: "he", IR: "fa",
};

/**
 * Fold text for matching: case and Latin accents are ignored ("Español"
 * matches "espanol"), and every other script is kept, so a language can be
 * found by its own name ("日本語", "Русский").
 */
function normalizeSearchText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function collatorCompare(a: SpeechLanguageOption, b: SpeechLanguageOption): number {
  if (a.tag === "multi") return -1;
  if (b.tag === "multi") return 1;
  return a.label.localeCompare(b.label, undefined, { sensitivity: "base" }) ||
    (a.regionLabel ?? "").localeCompare(b.regionLabel ?? "", undefined, { sensitivity: "base" }) ||
    a.tag.localeCompare(b.tag);
}

export function speechLanguageDisplayName(option: SpeechLanguageOption): string {
  return `${option.label} - ${option.regionLabel ?? option.tag}`;
}

function speechLanguageSearchKey(option: SpeechLanguageOption): string {
  return normalizeSearchText(
    [option.label, option.regionLabel, option.tag, ...(option.aliases ?? [])]
      .filter(Boolean)
      .join(" "),
  );
}

export function speechLanguageMatchesQuery(option: SpeechLanguageOption, query: string): boolean {
  const normalizedQuery = normalizeSearchText(query);
  return !normalizedQuery || speechLanguageSearchKey(option).includes(normalizedQuery);
}

function baseOf(tag: string): string {
  return tag.toLowerCase().split(/[-_]/)[0] ?? "";
}

export function loadSavedSpokenLanguage(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return normalizeSpeechLanguageTag(window.localStorage.getItem(SPOKEN_LANGUAGE_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function saveSpokenLanguage(language: string): void {
  if (typeof window === "undefined") return;
  const normalized = normalizeSpeechLanguageTag(language);
  if (!normalized) return;
  try {
    window.localStorage.setItem(SPOKEN_LANGUAGE_STORAGE_KEY, normalized);
  } catch {
    // localStorage may be unavailable in private contexts.
  }
}

const CAPTIONS_SHOWN_STORAGE_KEY = "orbmeet.captions-shown.v1";

/** Whether this browser last chose to see captions over the meeting; off until it does. */
export function loadCaptionsShown(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(CAPTIONS_SHOWN_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveCaptionsShown(shown: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CAPTIONS_SHOWN_STORAGE_KEY, shown ? "1" : "0");
  } catch {
    // localStorage may be unavailable in private contexts.
  }
}

export function pickSpeechLanguage({
  savedLanguage,
  navigatorLanguage,
  country,
}: {
  savedLanguage?: string | null;
  navigatorLanguage?: string | null;
  country?: string | null;
}): string {
  const saved = normalizeSpeechLanguageTag(savedLanguage);
  if (saved) return saved;

  const region = country?.trim().toUpperCase() || null;
  const navBase = navigatorLanguage ? baseOf(navigatorLanguage) : null;
  if (navBase) {
    if (region) {
      const regional = SPEECH_LANGUAGE_OPTIONS.find(
        (option) => baseOf(option.tag) === navBase && option.tag.toUpperCase().endsWith(`-${region}`),
      );
      if (regional) return regional.tag;
      const countryDefault = COUNTRY_DEFAULT_LANGUAGE[region];
      if (countryDefault && baseOf(countryDefault) === navBase) return countryDefault;
    }
    const normalized = normalizeSpeechLanguageTag(navigatorLanguage);
    if (normalized) return normalized;
  }

  if (region) return COUNTRY_DEFAULT_LANGUAGE[region] ?? DEFAULT_SPEECH_LANGUAGE;
  return DEFAULT_SPEECH_LANGUAGE;
}

function languageOptionsForCountry(country: string | null | undefined): SpeechLanguageOption[] {
  const region = country?.trim().toUpperCase();
  if (!region) return [];
  const preferredTag = COUNTRY_DEFAULT_LANGUAGE[region];
  return SPEECH_LANGUAGE_OPTIONS
    .filter((option) => option.tag === preferredTag || option.tag.toUpperCase().endsWith(`-${region}`))
    .sort(collatorCompare);
}

export function orderSpeechLanguagesForCountry(country: string | null | undefined): SpeechLanguageOption[] {
  const regional = languageOptionsForCountry(country);
  const regionalTags = new Set(regional.map((option) => option.tag));
  return [
    ...regional,
    ...SPEECH_LANGUAGE_OPTIONS.filter((option) => !regionalTags.has(option.tag)).sort(collatorCompare),
  ];
}
