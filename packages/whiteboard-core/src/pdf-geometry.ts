export const PDF_A4_WIDTH_PT = 595.28;

export const PDF_MAX_IMPORT_SIZE = 50 * 1024 * 1024; // 50 MB
// Server-side safety cap for the number of pages rendered by one import. A
// source PDF may be longer when the caller selects a range within this limit.
// The whiteboard layer separately limits the document's total page count.
export const PDF_MAX_RENDER_PAGES = 100;
export const PDF_SOURCE_FILE_ID_MAX_LENGTH = 128;

export function isPdfSourceFileId(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= PDF_SOURCE_FILE_ID_MAX_LENGTH;
}

// A page rasterized to PNG at import DPI is usually a few× the source PDF's
// (vector) bytes, but the exact size is unknown until the render runs. The import
// preflight reserves a generous multiple of the upload size — not the hard 50 MB
// max — so a small import doesn't pre-claim a quota-limited user's entire
// allowance; the commit phase then reconciles against the real rendered bytes.
const PDF_IMPORT_RESERVE_MULTIPLIER = 4;
const PDF_IMPORT_MIN_RESERVE_BYTES = 2 * 1024 * 1024;

export function estimatePdfImportReserveBytes(pdfByteLength: number): number {
  const estimate = Math.max(
    PDF_IMPORT_MIN_RESERVE_BYTES,
    pdfByteLength * PDF_IMPORT_RESERVE_MULTIPLIER,
  );
  return Math.min(estimate, PDF_MAX_IMPORT_SIZE);
}

export interface FitResult {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function fitContained(
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
): FitResult {
  if (
    !Number.isFinite(srcW) || !Number.isFinite(srcH) ||
    !Number.isFinite(dstW) || !Number.isFinite(dstH) ||
    srcW <= 0 || srcH <= 0 || dstW <= 0 || dstH <= 0
  ) {
    return {
      x: Number.isFinite(dstW) ? dstW / 2 : 0,
      y: Number.isFinite(dstH) ? dstH / 2 : 0,
      width: 0,
      height: 0,
    };
  }
  const scale = Math.min(dstW / srcW, dstH / srcH);
  const width = srcW * scale;
  const height = srcH * scale;
  return {
    x: (dstW - width) / 2,
    y: (dstH - height) / 2,
    width,
    height,
  };
}

export function unionBounds(
  boundsList: Array<{ x: number; y: number; w: number; h: number }>,
): { x: number; y: number; w: number; h: number } | null {
  if (boundsList.length === 0) return null;

  let minX = boundsList[0].x;
  let minY = boundsList[0].y;
  let maxX = boundsList[0].x + boundsList[0].w;
  let maxY = boundsList[0].y + boundsList[0].h;

  for (let i = 1; i < boundsList.length; i += 1) {
    const b = boundsList[i];
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w);
    maxY = Math.max(maxY, b.y + b.h);
  }

  return {
    x: minX,
    y: minY,
    w: Math.max(1, maxX - minX),
    h: Math.max(1, maxY - minY),
  };
}
