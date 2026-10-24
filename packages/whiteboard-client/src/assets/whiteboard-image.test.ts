import { describe, expect, it } from "vitest";
import {
  WHITEBOARD_IMAGE_ACCEPT_ATTR,
  WHITEBOARD_MAX_IMAGE_BYTES,
  WHITEBOARD_SUPPORTED_IMAGE_MIME_TYPES,
  inferWhiteboardImageMimeTypeFromFileName,
  isSupportedWhiteboardImageFileName,
  isSupportedWhiteboardImageMimeType,
  looksLikeWhiteboardImageUrl,
} from "./whiteboard-image";

describe("whiteboard image policy", () => {
  it("uses a 10 MB image limit", () => {
    expect(WHITEBOARD_MAX_IMAGE_BYTES).toBe(10 * 1024 * 1024);
  });

  it("only allows browser-safe image MIME types", () => {
    expect(WHITEBOARD_SUPPORTED_IMAGE_MIME_TYPES).toEqual([
      "image/png",
      "image/jpeg",
      "image/gif",
      "image/webp",
    ]);
    expect(WHITEBOARD_IMAGE_ACCEPT_ATTR).toBe(
      "image/png,image/jpeg,image/gif,image/webp"
    );
  });

  it("matches allowed MIME types", () => {
    expect(isSupportedWhiteboardImageMimeType("image/png")).toBe(true);
    expect(isSupportedWhiteboardImageMimeType("image/svg+xml")).toBe(false);
    expect(isSupportedWhiteboardImageMimeType("image/avif")).toBe(false);
  });

  it("matches allowed file names", () => {
    expect(isSupportedWhiteboardImageFileName("photo.png")).toBe(true);
    expect(isSupportedWhiteboardImageFileName("photo.jpeg")).toBe(true);
    expect(isSupportedWhiteboardImageFileName("photo.webp")).toBe(true);
    expect(isSupportedWhiteboardImageFileName("photo.svg")).toBe(false);
    expect(isSupportedWhiteboardImageFileName("photo.heic")).toBe(false);
  });

  it("infers MIME types from supported file names", () => {
    expect(inferWhiteboardImageMimeTypeFromFileName("photo.png")).toBe(
      "image/png"
    );
    expect(inferWhiteboardImageMimeTypeFromFileName("photo.jpg")).toBe(
      "image/jpeg"
    );
    expect(inferWhiteboardImageMimeTypeFromFileName("photo.webp")).toBe(
      "image/webp"
    );
    expect(inferWhiteboardImageMimeTypeFromFileName("photo.bmp")).toBeNull();
  });

  it("only recognizes supported whiteboard image URLs", () => {
    expect(
      looksLikeWhiteboardImageUrl("https://example.com/image.png?width=320")
    ).toBe(true);
    expect(looksLikeWhiteboardImageUrl("https://example.com/photo.jpg#hero")).toBe(
      true
    );
    expect(looksLikeWhiteboardImageUrl("https://example.com/photo.svg")).toBe(
      false
    );
    expect(looksLikeWhiteboardImageUrl("https://example.com/photo.avif")).toBe(
      false
    );
    expect(looksLikeWhiteboardImageUrl("data:image/png;base64,abc")).toBe(
      false
    );
  });
});
