export interface ImageDimensions {
  width: number;
  height: number;
}

const HEADER_BYTES = 65536;

export async function readImageDimensionsFromFile(
  file: File,
): Promise<ImageDimensions | null> {
  const slice = file.slice(0, Math.min(file.size, HEADER_BYTES));
  const buf = new Uint8Array(await slice.arrayBuffer());
  return parseImageDimensions(buf, file.type);
}

function parseImageDimensions(
  buf: Uint8Array,
  mimeType: string,
): ImageDimensions | null {
  if (mimeType === "image/png" || isPng(buf)) return parsePng(buf);
  if (mimeType === "image/jpeg" || isJpeg(buf)) return parseJpeg(buf);
  if (mimeType === "image/gif" || isGif(buf)) return parseGif(buf);
  if (mimeType === "image/webp" || isWebP(buf)) return parseWebP(buf);
  return null;
}

function isPng(buf: Uint8Array): boolean {
  return buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
}

function isJpeg(buf: Uint8Array): boolean {
  return buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xd8;
}

function isGif(buf: Uint8Array): boolean {
  return buf.length >= 10 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46;
}

function isWebP(buf: Uint8Array): boolean {
  return (
    buf.length >= 12 &&
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  );
}

function parsePng(buf: Uint8Array): ImageDimensions | null {
  if (buf.length < 24) return null;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function parseGif(buf: Uint8Array): ImageDimensions | null {
  if (buf.length < 10) return null;
  const width = buf[6] | (buf[7] << 8);
  const height = buf[8] | (buf[9] << 8);
  return { width, height };
}

/**
 * A JPEG's displayed dimensions. Browsers and `createImageBitmap` decode with
 * the EXIF orientation applied, so a portrait phone photo stored landscape
 * (orientations 5-8: rotated a quarter turn) is laid out with its sides
 * swapped. Reporting the stored size would squash it into the wrong box.
 */
function parseJpeg(buf: Uint8Array): ImageDimensions | null {
  if (buf.length < 2) return null;
  let rotated = false;
  let offset = 2;
  while (offset + 4 < buf.length) {
    if (buf[offset] !== 0xff) return null;
    const marker = buf[offset + 1];

    if (marker === 0xd9) return null; // EOI
    if (marker === 0xda) return null; // SOS — no SOF found before scan data

    // SOF markers: C0-CF except C4 (DHT), C8 (reserved), CC (DAC)
    if (
      marker >= 0xc0 && marker <= 0xcf &&
      marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    ) {
      if (offset + 9 > buf.length) return null;
      const height = (buf[offset + 5] << 8) | buf[offset + 6];
      const width = (buf[offset + 7] << 8) | buf[offset + 8];
      return rotated ? { width: height, height: width } : { width, height };
    }

    // Skip segment
    const segLen = (buf[offset + 2] << 8) | buf[offset + 3];
    // APP1 also carries XMP and other metadata; only an EXIF segment that
    // states an orientation says anything about it.
    const orientation = marker === 0xe1 ? readExifOrientation(buf, offset + 4, offset + 2 + segLen) : null;
    if (orientation !== null) rotated = orientation >= 5 && orientation <= 8;
    offset += 2 + segLen;
  }
  return null;
}

/** The EXIF orientation tag in an APP1 segment spanning [start, end), if any. */
function readExifOrientation(buf: Uint8Array, start: number, end: number): number | null {
  const limit = Math.min(end, buf.length);
  // "Exif\0\0", then a TIFF header.
  if (
    start + 14 > limit ||
    buf[start] !== 0x45 || buf[start + 1] !== 0x78 || buf[start + 2] !== 0x69 ||
    buf[start + 3] !== 0x66 || buf[start + 4] !== 0 || buf[start + 5] !== 0
  ) {
    return null;
  }
  const tiff = start + 6;
  const little = buf[tiff] === 0x49 && buf[tiff + 1] === 0x49;
  const big = buf[tiff] === 0x4d && buf[tiff + 1] === 0x4d;
  if (!little && !big) return null;
  const u16 = (at: number) => (little ? buf[at] | (buf[at + 1] << 8) : (buf[at] << 8) | buf[at + 1]);
  const u32 = (at: number) =>
    little
      ? (buf[at] | (buf[at + 1] << 8) | (buf[at + 2] << 16) | (buf[at + 3] << 24)) >>> 0
      : ((buf[at] << 24) | (buf[at + 1] << 16) | (buf[at + 2] << 8) | buf[at + 3]) >>> 0;
  const ifd = tiff + u32(tiff + 4);
  if (ifd + 2 > limit) return null;
  const entries = u16(ifd);
  for (let index = 0; index < entries; index++) {
    const entry = ifd + 2 + index * 12;
    if (entry + 12 > limit) return null;
    if (u16(entry) === 0x0112) return u16(entry + 8);
  }
  return null;
}

function parseWebP(buf: Uint8Array): ImageDimensions | null {
  if (buf.length < 16) return null;

  // Find chunk type at offset 12
  const chunk = String.fromCharCode(buf[12], buf[13], buf[14], buf[15]);

  if (chunk === "VP8 " && buf.length >= 30) {
    // Lossy: keyframe starts at offset 20 (after 12 RIFF + 4 type + 4 size)
    // Frame tag 3 bytes, then sync code 0x9D 0x01 0x2A
    const dataStart = 20;
    if (
      buf[dataStart + 3] === 0x9d &&
      buf[dataStart + 4] === 0x01 &&
      buf[dataStart + 5] === 0x2a
    ) {
      const width = (buf[dataStart + 6] | (buf[dataStart + 7] << 8)) & 0x3fff;
      const height = (buf[dataStart + 8] | (buf[dataStart + 9] << 8)) & 0x3fff;
      return { width, height };
    }
  }

  if (chunk === "VP8L" && buf.length >= 25) {
    // Lossless: signature byte 0x2F at offset 20, then 4 bytes of packed dimensions
    const dataStart = 20;
    if (buf[dataStart] === 0x2f) {
      const bits =
        buf[dataStart + 1] |
        (buf[dataStart + 2] << 8) |
        (buf[dataStart + 3] << 16) |
        (buf[dataStart + 4] << 24);
      const width = (bits & 0x3fff) + 1;
      const height = ((bits >> 14) & 0x3fff) + 1;
      return { width, height };
    }
  }

  if (chunk === "VP8X" && buf.length >= 30) {
    // Extended: canvas dimensions at data offset 4 (24-bit LE each)
    const dataStart = 20;
    const width = 1 + (buf[dataStart + 4] | (buf[dataStart + 5] << 8) | (buf[dataStart + 6] << 16));
    const height = 1 + (buf[dataStart + 7] | (buf[dataStart + 8] << 8) | (buf[dataStart + 9] << 16));
    return { width, height };
  }

  return null;
}
