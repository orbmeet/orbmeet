import { describe, expect, it } from "vitest";

import {
  DEFAULT_SPEECH_LANGUAGE,
  isSupportedSpeechLanguageTag,
  normalizeSpeechLanguage,
  normalizeSpeechLanguageTag,
  SUPPORTED_SPEECH_LANGUAGE_TAGS,
} from "./languages";

describe("supported speech language tags", () => {
  it("are unique and include the default", () => {
    expect(new Set(SUPPORTED_SPEECH_LANGUAGE_TAGS).size).toBe(
      SUPPORTED_SPEECH_LANGUAGE_TAGS.length,
    );
    expect(SUPPORTED_SPEECH_LANGUAGE_TAGS).toContain(DEFAULT_SPEECH_LANGUAGE);
  });
});

describe("normalizeSpeechLanguageTag", () => {
  it("returns canonical tags unchanged and accepts the nullish inputs", () => {
    expect(normalizeSpeechLanguageTag("en-US")).toBe("en-US");
    expect(normalizeSpeechLanguageTag("multi")).toBe("multi");
    expect(normalizeSpeechLanguageTag(null)).toBeNull();
    expect(normalizeSpeechLanguageTag(undefined)).toBeNull();
    expect(normalizeSpeechLanguageTag("   ")).toBeNull();
    expect(normalizeSpeechLanguageTag("")).toBeNull();
  });

  it("falls back to null for unknown input rather than guessing", () => {
    expect(normalizeSpeechLanguageTag("klingon")).toBeNull();
    expect(normalizeSpeechLanguageTag("xx-YY")).toBeNull();
  });

  it("canonicalizes case and underscore region separators", () => {
    expect(normalizeSpeechLanguageTag("EN-us")).toBe("en-US");
    expect(normalizeSpeechLanguageTag("PT-br")).toBe("pt-BR");
    expect(normalizeSpeechLanguageTag("en_US")).toBe("en-US");
  });

  it("maps Chinese dialect families deliberately", () => {
    expect(normalizeSpeechLanguageTag("zh")).toBe("zh-CN");
    expect(normalizeSpeechLanguageTag("zh-CN")).toBe("zh-CN");
    expect(normalizeSpeechLanguageTag("zh-Hans-SG")).toBe("zh-CN");
    expect(normalizeSpeechLanguageTag("zh-TW")).toBe("zh-TW");
    expect(normalizeSpeechLanguageTag("zh-Hant")).toBe("zh-TW");
    expect(normalizeSpeechLanguageTag("zh_TW")).toBe("zh-TW");
    expect(normalizeSpeechLanguageTag("zh-HK")).toBe("zh-HK");
    expect(normalizeSpeechLanguageTag("zh_MO")).toBe("zh-HK");
    expect(normalizeSpeechLanguageTag("yue")).toBe("zh-HK");
  });

  it("maps Norwegian Macrolanguage codes to Deepgram's `no`", () => {
    expect(normalizeSpeechLanguageTag("no")).toBe("no");
    expect(normalizeSpeechLanguageTag("nb")).toBe("no");
    expect(normalizeSpeechLanguageTag("nb-NO")).toBe("no");
    expect(normalizeSpeechLanguageTag("nn_NO")).toBe("no");
  });

  it("narrows bare base languages to their canonical dialect", () => {
    expect(normalizeSpeechLanguageTag("da")).toBe("da-DK");
    expect(normalizeSpeechLanguageTag("fil")).toBe("tl");
    expect(normalizeSpeechLanguageTag("pt")).toBe("pt-BR");
    expect(normalizeSpeechLanguageTag("ko")).toBe("ko-KR");
  });

  it("reports supported tags exactly and case-insensitively", () => {
    expect(isSupportedSpeechLanguageTag("zh-HK")).toBe(true);
    expect(isSupportedSpeechLanguageTag("zh-hk")).toBe(true);
    expect(isSupportedSpeechLanguageTag("zh")).toBe(false);
    expect(isSupportedSpeechLanguageTag("nb")).toBe(false);
  });
});

describe("normalizeSpeechLanguage", () => {
  it("substitutes the default for unknown input", () => {
    expect(normalizeSpeechLanguage("klingon")).toBe("en-US");
    expect(normalizeSpeechLanguage(undefined)).toBe("en-US");
  });

  it("honors an explicit fallback while still normalizing known input", () => {
    expect(normalizeSpeechLanguage("nb-NO", "multi")).toBe("no");
    expect(normalizeSpeechLanguage("klingon", "multi")).toBe("multi");
  });
});
