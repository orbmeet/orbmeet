import { describe, expect, it } from "vitest";
import { meetingPreviewUrl, sniffPreviewImageType } from "./meeting-preview";

const bytes = (text: string) => Uint8Array.from(text, (char) => char.charCodeAt(0));

describe("sniffPreviewImageType", () => {
  it("knows a WebP and a PNG by their bytes", () => {
    expect(sniffPreviewImageType(bytes("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
    expect(sniffPreviewImageType(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe("image/png");
  });

  it("refuses anything else, however it is labelled", () => {
    expect(sniffPreviewImageType(bytes("<svg onload=alert(1)>"))).toBeNull();
    expect(sniffPreviewImageType(bytes("RIFF\0\0\0\0WAVEfmt "))).toBeNull();
    expect(sniffPreviewImageType(new Uint8Array())).toBeNull();
  });
});

describe("meetingPreviewUrl", () => {
  it("keeps the id one path segment", () => {
    expect(meetingPreviewUrl("meeting_01/../x")).toBe("/api/whiteboard/meeting-preview/meeting_01%2F..%2Fx");
  });
});
