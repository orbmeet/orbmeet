import { describe, expect, it } from "vitest";
import { isWhiteboardImageHeader } from "./upload-image-format";

const ascii = (value: string) => new TextEncoder().encode(value);

describe("isWhiteboardImageHeader", () => {
  it("recognizes each accepted image container", () => {
    expect(isWhiteboardImageHeader("image/png", new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
    ]))).toBe(true);
    expect(isWhiteboardImageHeader("image/jpeg", new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe(true);
    expect(isWhiteboardImageHeader("image/gif", ascii("GIF89a"))).toBe(true);
    expect(isWhiteboardImageHeader("image/webp", ascii("RIFF0000WEBP"))).toBe(true);
  });

  it("rejects mismatches and active-content bytes", () => {
    const html = ascii("<svg onload=");
    for (const mime of ["image/png", "image/jpeg", "image/gif", "image/webp"]) {
      expect(isWhiteboardImageHeader(mime, html)).toBe(false);
    }
    expect(isWhiteboardImageHeader("image/png", ascii("GIF89a"))).toBe(false);
  });
});
