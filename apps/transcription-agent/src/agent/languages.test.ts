import { describe, expect, it } from "vitest";
import { normalizeLanguage } from "./languages.js";

describe("normalizeLanguage", () => {
  it("keeps supported Deepgram language tags", () => {
    expect(normalizeLanguage("bn")).toBe("bn");
    expect(normalizeLanguage("en-GB")).toBe("en-GB");
    expect(normalizeLanguage("multi")).toBe("multi");
  });

  it("canonicalizes browser-style tags and falls back safely", () => {
    expect(normalizeLanguage("ja-JP")).toBe("ja");
    expect(normalizeLanguage("EN-us")).toBe("en-US");
    expect(normalizeLanguage("unsupported")).toBe("en-US");
  });

  it("preserves Norwegian and Chinese locale families", () => {
    expect(normalizeLanguage("nb-NO")).toBe("no");
    expect(normalizeLanguage("nn_NO")).toBe("no");
    expect(normalizeLanguage("zh-Hant")).toBe("zh-TW");
    expect(normalizeLanguage("zh-HK")).toBe("zh-HK");
    expect(normalizeLanguage("zh-Hans-SG")).toBe("zh-CN");
  });
});
