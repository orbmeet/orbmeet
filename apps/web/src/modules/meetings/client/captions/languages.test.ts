import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SPEECH_LANGUAGE,
  loadSavedSpokenLanguage,
  normalizeSpeechLanguageTag,
  pickSpeechLanguage,
  saveSpokenLanguage,
  SPEECH_LANGUAGE_OPTIONS,
  speechLanguageMatchesQuery,
  SPOKEN_LANGUAGE_STORAGE_KEY,
} from "./languages";

function stubLocalStorage() {
  const store = new Map<string, string>();
  const localStorage = {
    getItem: vi.fn((key: string) => store.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      store.delete(key);
    }),
  };

  vi.stubGlobal("window", { localStorage });
  return { localStorage, store };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("spoken language preference", () => {
  it("normalizes case and writes only the current storage key", () => {
    const { store } = stubLocalStorage();

    saveSpokenLanguage("bn-bd");

    expect(store.get(SPOKEN_LANGUAGE_STORAGE_KEY)).toBe("bn");
  });

  it("loads the saved language", () => {
    const { store } = stubLocalStorage();
    store.set(SPOKEN_LANGUAGE_STORAGE_KEY, "bn-BD");

    expect(loadSavedSpokenLanguage()).toBe("bn");
  });

  it("returns null when nothing is saved", () => {
    stubLocalStorage();

    expect(loadSavedSpokenLanguage()).toBeNull();
  });
});

describe("pickSpeechLanguage", () => {
  it("returns the saved choice when present, ignoring everything else", () => {
    expect(
      pickSpeechLanguage({
        savedLanguage: "ja-JP",
        navigatorLanguage: "en-US",
        country: "IN",
      }),
    ).toBe("ja");
  });

  it("does not return the saved choice when it is not a supported tag", () => {
    expect(
      pickSpeechLanguage({
        savedLanguage: "xx-YY",
        navigatorLanguage: "en-US",
        country: "US",
      }),
    ).toBe("en-US");
  });

  it("narrows navigator base language to the user's country when possible", () => {
    // Indian English speaker — must NOT default to Bangla just because IN
    // has Bangla as the alphabetically-first regional variant.
    expect(
      pickSpeechLanguage({
        navigatorLanguage: "en",
        country: "IN",
      }),
    ).toBe("en-IN");

    expect(
      pickSpeechLanguage({
        navigatorLanguage: "en-US",
        country: "ZA",
      }),
    ).toBe("en-US");

    expect(
      pickSpeechLanguage({
        navigatorLanguage: "es",
        country: "MX",
      }),
    ).toBe("es-419");
  });

  it("uses the canonical variant for a base language when no country variant exists", () => {
    expect(pickSpeechLanguage({ navigatorLanguage: "en" })).toBe("en-US");
    expect(pickSpeechLanguage({ navigatorLanguage: "es" })).toBe("es");
    expect(pickSpeechLanguage({ navigatorLanguage: "pt" })).toBe("pt-BR");
    expect(pickSpeechLanguage({ navigatorLanguage: "zh" })).toBe("zh-CN");
    expect(pickSpeechLanguage({ navigatorLanguage: "bn" })).toBe("bn");
  });

  it("ignores country narrowing for languages with no regional variant there", () => {
    // ja has no -IN variant; should fall through to the canonical Japanese.
    expect(
      pickSpeechLanguage({ navigatorLanguage: "ja", country: "IN" }),
    ).toBe("ja");
  });

  it("falls back to the country-default when navigator gives nothing", () => {
    expect(pickSpeechLanguage({ country: "IN" })).toBe("hi");
    expect(pickSpeechLanguage({ country: "BD" })).toBe("bn");
    expect(pickSpeechLanguage({ country: "FR" })).toBe("fr");
    expect(pickSpeechLanguage({ country: "JP" })).toBe("ja");
  });

  it("falls back to en-US for unknown countries with no other hint", () => {
    expect(pickSpeechLanguage({ country: "ZZ" })).toBe(DEFAULT_SPEECH_LANGUAGE);
    expect(pickSpeechLanguage({})).toBe(DEFAULT_SPEECH_LANGUAGE);
  });

  it("handles full navigator tags like en_US (underscore form)", () => {
    expect(pickSpeechLanguage({ navigatorLanguage: "en_US" })).toBe("en-US");
  });

  it("treats blank strings as missing", () => {
    expect(
      pickSpeechLanguage({
        savedLanguage: "",
        navigatorLanguage: "",
        country: "",
      }),
    ).toBe(DEFAULT_SPEECH_LANGUAGE);
  });
});

describe("speechLanguageMatchesQuery", () => {
  const option = (tag: string) => SPEECH_LANGUAGE_OPTIONS.find((candidate) => candidate.tag === tag)!;

  it("finds a language by its own name, in its own script", () => {
    expect(speechLanguageMatchesQuery(option("ja"), "日本語")).toBe(true);
    expect(speechLanguageMatchesQuery(option("ru"), "русский")).toBe(true);
    expect(speechLanguageMatchesQuery(option("hi"), "हिन्दी")).toBe(true);
  });

  it("filters on a query in another script instead of matching everything", () => {
    expect(speechLanguageMatchesQuery(option("en-US"), "日本語")).toBe(false);
  });

  it("ignores case and accents in Latin names", () => {
    expect(speechLanguageMatchesQuery(option("es"), "ESPANOL")).toBe(true);
    expect(speechLanguageMatchesQuery(option("fr"), "français")).toBe(true);
  });
});

describe("normalizeSpeechLanguageTag (shared caption-protocol semantics)", () => {
  it("returns null for unsupported tags so callers can fail visibly", () => {
    expect(normalizeSpeechLanguageTag("xx-YY")).toBeNull();
    expect(normalizeSpeechLanguageTag("")).toBeNull();
  });

  it("normalizes Norwegian and Chinese inputs onto the shared canonical tags", () => {
    expect(normalizeSpeechLanguageTag("nb-NO")).toBe("no");
    expect(normalizeSpeechLanguageTag("zh-Hant")).toBe("zh-TW");
    expect(normalizeSpeechLanguageTag("zh_MO")).toBe("zh-HK");
  });
});
