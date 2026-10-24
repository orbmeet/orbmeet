import { describe, expect, it } from "vitest";
import { looksLikeImageUrl } from "./import-image";

describe("looksLikeImageUrl", () => {
  it("accepts common image URLs", () => {
    expect(
      looksLikeImageUrl("https://example.com/image.png?width=320")
    ).toBe(true);
  });

  it("rejects non-image pages and invalid URLs", () => {
    expect(looksLikeImageUrl("https://en.wikipedia.org/wiki/Pythagorean_theorem")).toBe(false);
    expect(looksLikeImageUrl("not-a-url")).toBe(false);
    expect(looksLikeImageUrl("data:image/png;base64,abc")).toBe(false);
  });

  it("accepts URLs with image extensions and query strings or fragments", () => {
    expect(looksLikeImageUrl("https://example.com/photo.jpg#section")).toBe(true);
    expect(looksLikeImageUrl("https://example.com/photo.webp?size=large")).toBe(true);
    expect(looksLikeImageUrl("https://example.com/photo.gif")).toBe(true);
  });

  it("rejects unsupported image formats", () => {
    expect(
      looksLikeImageUrl(
        "https://upload.wikimedia.org/wikipedia/commons/a/a0/Pythagorean.svg"
      )
    ).toBe(false);
    expect(looksLikeImageUrl("https://example.com/photo.bmp")).toBe(false);
    expect(looksLikeImageUrl("https://example.com/photo.avif")).toBe(false);
  });

  it("rejects non-http protocols", () => {
    expect(looksLikeImageUrl("ftp://example.com/image.png")).toBe(false);
    expect(looksLikeImageUrl("ws://example.com/image.png")).toBe(false);
  });
});
