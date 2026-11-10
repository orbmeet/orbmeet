import { afterEach, describe, expect, it, vi } from "vitest";
import { looksLikeImageUrl, maybeOptimizeImageForWhiteboard } from "./import-image";

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

describe("maybeOptimizeImageForWhiteboard", () => {
  afterEach(() => vi.unstubAllGlobals());

  /** A canvas whose encoder answers with `encodedType`, whatever it was asked for. */
  function stubEncoder(encodedType: string) {
    const requested: string[] = [];
    vi.stubGlobal("createImageBitmap", async () => ({ close() {} }));
    vi.stubGlobal(
      "OffscreenCanvas",
      class {
        getContext() {
          return { drawImage() {} };
        }
        async convertToBlob({ type }: { type: string }) {
          requested.push(type);
          return new Blob([new Uint8Array(1024)], { type: encodedType });
        }
      },
    );
    return requested;
  }

  // A 4K screenshot: past the edge limit, so it is always re-encoded.
  const screenshot = () =>
    new File([new Uint8Array(3 * 1024 * 1024)], "Screenshot.png", { type: "image/png" });

  it("describes a WebP encode as WebP", async () => {
    const requested = stubEncoder("image/webp");
    const result = await maybeOptimizeImageForWhiteboard(screenshot(), 3840, 2160);

    expect(requested).toEqual(["image/webp"]);
    expect(result.file.type).toBe("image/webp");
    expect(result.file.name).toBe("Screenshot.webp");
  });

  it("describes the encoder's PNG fallback as PNG, as Safari returns it", async () => {
    stubEncoder("image/png");
    const result = await maybeOptimizeImageForWhiteboard(screenshot(), 3840, 2160);

    expect(result.file.type).toBe("image/png");
    expect(result.file.name).toBe("Screenshot.png");
    expect(result.width).toBe(2400);
  });

  it("keeps the original when the encoder returns a type the board cannot take", async () => {
    stubEncoder("image/bmp");
    const original = screenshot();
    const result = await maybeOptimizeImageForWhiteboard(original, 3840, 2160);

    expect(result.file).toBe(original);
  });
});
