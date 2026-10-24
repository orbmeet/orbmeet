import { describe, expect, it } from "vitest";
import { readImageDimensionsFromFile } from "./read-image-dimensions";

function makeFile(bytes: Uint8Array, name: string, type: string): File {
  return new File([bytes as BlobPart], name, { type });
}

// Minimal valid PNG: 8-byte signature + IHDR chunk (13 bytes data)
function buildPng(width: number, height: number): Uint8Array {
  const buf = new Uint8Array(33);
  // PNG signature
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  // IHDR chunk length (13)
  buf.set([0, 0, 0, 13], 8);
  // IHDR tag
  buf.set([0x49, 0x48, 0x44, 0x52], 12);
  // Width (big-endian)
  new DataView(buf.buffer).setUint32(16, width);
  // Height (big-endian)
  new DataView(buf.buffer).setUint32(20, height);
  return buf;
}

// Minimal GIF header
function buildGif(width: number, height: number): Uint8Array {
  const buf = new Uint8Array(10);
  buf.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]); // GIF89a
  buf[6] = width & 0xff;
  buf[7] = (width >> 8) & 0xff;
  buf[8] = height & 0xff;
  buf[9] = (height >> 8) & 0xff;
  return buf;
}

// Minimal JPEG with SOF0 marker
function buildJpeg(width: number, height: number): Uint8Array {
  const buf = new Uint8Array(20);
  buf[0] = 0xff; buf[1] = 0xd8; // SOI
  buf[2] = 0xff; buf[3] = 0xc0; // SOF0
  buf[4] = 0x00; buf[5] = 0x11; // segment length = 17
  buf[6] = 0x08; // precision
  buf[7] = (height >> 8) & 0xff; buf[8] = height & 0xff;
  buf[9] = (width >> 8) & 0xff; buf[10] = width & 0xff;
  return buf;
}

// JPEG with APP0 (JFIF) + APP1 (EXIF) segments before SOF0
function buildJpegWithExif(width: number, height: number): Uint8Array {
  const buf = new Uint8Array(40);
  let o = 0;
  buf[o++] = 0xff; buf[o++] = 0xd8; // SOI
  // APP0 segment (marker + length 8 = 6 bytes data)
  buf[o++] = 0xff; buf[o++] = 0xe0; // APP0
  buf[o++] = 0x00; buf[o++] = 0x08; // segment length = 8
  o += 6; // skip data bytes
  // APP1 segment (marker + length 6 = 4 bytes data)
  buf[o++] = 0xff; buf[o++] = 0xe1; // APP1
  buf[o++] = 0x00; buf[o++] = 0x06; // segment length = 6
  o += 4; // skip data bytes
  // SOF0
  buf[o++] = 0xff; buf[o++] = 0xc0;
  buf[o++] = 0x00; buf[o++] = 0x11; // segment length = 17
  buf[o++] = 0x08; // precision
  buf[o++] = (height >> 8) & 0xff; buf[o] = height & 0xff; o++;
  buf[o++] = (width >> 8) & 0xff; buf[o] = width & 0xff;
  return buf;
}

// JPEG whose APP1 EXIF block carries an orientation tag, optionally followed
// by an XMP block (also APP1), as phones and editors write them.
function buildJpegWithOrientation(
  width: number,
  height: number,
  orientation: number,
  little: boolean,
  withXmp = false,
): Uint8Array {
  const exif = [0x45, 0x78, 0x69, 0x66, 0, 0]; // "Exif\0\0"
  const u16 = (v: number) => (little ? [v & 0xff, v >> 8] : [v >> 8, v & 0xff]);
  const u32 = (v: number) => (little ? [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, v >>> 24] : [v >>> 24, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff]);
  const tiff = [...(little ? [0x49, 0x49] : [0x4d, 0x4d]), ...u16(42), ...u32(8)];
  const ifd = [...u16(1), ...u16(0x0112), ...u16(3), ...u32(1), ...u16(orientation), 0, 0, ...u32(0)];
  const data = [...exif, ...tiff, ...ifd];
  const app1 = [0xff, 0xe1, (data.length + 2) >> 8, (data.length + 2) & 0xff, ...data];
  const xmpData = Array.from(new TextEncoder().encode("http://ns.adobe.com/xap/1.0/\0<x:xmpmeta/>"));
  const xmp = withXmp ? [0xff, 0xe1, (xmpData.length + 2) >> 8, (xmpData.length + 2) & 0xff, ...xmpData] : [];
  const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, ...Array.from({ length: 12 }, () => 0)];
  return new Uint8Array([0xff, 0xd8, ...app1, ...xmp, ...sof]);
}

// WebP VP8X (extended format)
function buildWebPVP8X(width: number, height: number): Uint8Array {
  const buf = new Uint8Array(30);
  // RIFF header
  buf.set([0x52, 0x49, 0x46, 0x46]); // "RIFF"
  buf.set([0x00, 0x00, 0x00, 0x00], 4); // file size (unused for test)
  buf.set([0x57, 0x45, 0x42, 0x50], 8); // "WEBP"
  // VP8X chunk
  buf.set([0x56, 0x50, 0x38, 0x58], 12); // "VP8X"
  buf.set([0x0a, 0x00, 0x00, 0x00], 16); // chunk size = 10
  // 4 bytes flags at offset 20
  buf[20] = 0x00; buf[21] = 0x00; buf[22] = 0x00; buf[23] = 0x00;
  // canvas width - 1 (24-bit LE) at offset 24
  const w = width - 1;
  buf[24] = w & 0xff; buf[25] = (w >> 8) & 0xff; buf[26] = (w >> 16) & 0xff;
  // canvas height - 1 (24-bit LE) at offset 27
  const h = height - 1;
  buf[27] = h & 0xff; buf[28] = (h >> 8) & 0xff; buf[29] = (h >> 16) & 0xff;
  return buf;
}

describe("readImageDimensionsFromFile", () => {
  it("reads PNG dimensions from header", async () => {
    const file = makeFile(buildPng(1920, 1080), "test.png", "image/png");
    const dims = await readImageDimensionsFromFile(file);
    expect(dims).toEqual({ width: 1920, height: 1080 });
  });

  it("reads GIF dimensions from header", async () => {
    const file = makeFile(buildGif(320, 240), "test.gif", "image/gif");
    const dims = await readImageDimensionsFromFile(file);
    expect(dims).toEqual({ width: 320, height: 240 });
  });

  it("reads JPEG dimensions from SOF marker", async () => {
    const file = makeFile(buildJpeg(4032, 3024), "test.jpg", "image/jpeg");
    const dims = await readImageDimensionsFromFile(file);
    expect(dims).toEqual({ width: 4032, height: 3024 });
  });

  it("returns null for unsupported format", async () => {
    const file = makeFile(new Uint8Array([0, 0, 0, 0]), "test.bmp", "image/bmp");
    const dims = await readImageDimensionsFromFile(file);
    expect(dims).toBeNull();
  });

  it("returns null for empty file", async () => {
    const file = makeFile(new Uint8Array(0), "test.png", "image/png");
    const dims = await readImageDimensionsFromFile(file);
    expect(dims).toBeNull();
  });

  it("handles large PNG dimensions", async () => {
    const file = makeFile(buildPng(9999, 9999), "big.png", "image/png");
    const dims = await readImageDimensionsFromFile(file);
    expect(dims).toEqual({ width: 9999, height: 9999 });
  });

  it("reads JPEG dimensions with EXIF segments before SOF", async () => {
    const file = makeFile(buildJpegWithExif(4032, 3024), "photo.jpg", "image/jpeg");
    const dims = await readImageDimensionsFromFile(file);
    expect(dims).toEqual({ width: 4032, height: 3024 });
  });

  it("reports a rotated phone photo's displayed size (REVIEW #4)", async () => {
    for (const little of [true, false]) {
      const rotated = makeFile(buildJpegWithOrientation(4000, 3000, 6, little), "portrait.jpg", "image/jpeg");
      await expect(readImageDimensionsFromFile(rotated)).resolves.toEqual({ width: 3000, height: 4000 });
      const upright = makeFile(buildJpegWithOrientation(4000, 3000, 1, little), "landscape.jpg", "image/jpeg");
      await expect(readImageDimensionsFromFile(upright)).resolves.toEqual({ width: 4000, height: 3000 });
    }
  });

  it("keeps a rotated photo's orientation through the XMP block after its EXIF", async () => {
    const rotated = makeFile(buildJpegWithOrientation(4000, 3000, 6, false, true), "portrait.jpg", "image/jpeg");
    await expect(readImageDimensionsFromFile(rotated)).resolves.toEqual({ width: 3000, height: 4000 });
  });

  it("reads WebP VP8X dimensions", async () => {
    const file = makeFile(buildWebPVP8X(1280, 720), "test.webp", "image/webp");
    const dims = await readImageDimensionsFromFile(file);
    expect(dims).toEqual({ width: 1280, height: 720 });
  });
});
