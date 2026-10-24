import { PDF_MAX_RENDER_PAGES } from "@orbmeet/whiteboard-core/pdf-geometry";
import { WHITEBOARD_CONFIG } from "@orbmeet/whiteboard-core/config";
import { WHITEBOARD_SYNC_ROUTES } from "@orbmeet/whiteboard-core/protocol";
import type { ImportedPdfPageSpec } from "../rooms/room-page-mutations.ts";

const MAX_IMPORTED_FRAME_HEIGHT = 100_000;
const MAX_IMPORTED_FILE_NAME_LENGTH = 255;

// Below this, process startup costs more than the parallelism buys.
const RENDER_SHARD_MIN_PAGES = 4;

const PDF_MAGIC = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // %PDF

/**
 * Split `firstPage..firstPage + pageCount - 1` into one contiguous range per
 * mutool process.
 *
 * Ranges are always derived from the document's real page count. mutool renders
 * the *last* page of a document for a range that lies entirely past the end
 * (verified against 1.25.6: `99-110` on a 12-page file emits `page-12.png`), so
 * a shard plan built from a guessed length would silently duplicate it.
 */
export function planRenderShards(
  pageCount: number,
  shardBudget: number,
  firstPage = 1,
): { first: number; last: number }[] {
  if (pageCount <= 0) return [];
  if (pageCount < RENDER_SHARD_MIN_PAGES || shardBudget <= 1) {
    return [{ first: firstPage, last: firstPage + pageCount - 1 }];
  }
  const shardCount = Math.min(shardBudget, pageCount);
  const pagesPerShard = Math.ceil(pageCount / shardCount);
  const ranges: { first: number; last: number }[] = [];
  const finalPage = firstPage + pageCount - 1;
  for (let first = firstPage; first <= finalPage; first += pagesPerShard) {
    ranges.push({ first, last: Math.min(finalPage, first + pagesPerShard - 1) });
  }
  return ranges;
}

export function parsePdfPageRange(
  url: URL,
  sourcePageCount: number,
): { start: number; end: number; count: number } | null {
  const startParam = url.searchParams.get("pageStart");
  const endParam = url.searchParams.get("pageEnd");
  if (startParam === null && endParam === null) {
    if (sourcePageCount > PDF_MAX_RENDER_PAGES) return null;
    return { start: 1, end: sourcePageCount, count: sourcePageCount };
  }
  if (startParam === null || endParam === null) return null;
  const start = Number(startParam);
  const end = Number(endParam);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 1 ||
    end < start ||
    end > sourcePageCount
  ) return null;
  const count = end - start + 1;
  if (count > PDF_MAX_RENDER_PAGES) return null;
  return { start, end, count };
}

/**
 * Where an import's pages go, from its start request: before the page at
 * `insertIndex` (0-based, clamped by the room), or onto `reuseFrameId`, which
 * the first page replaces. `maxPages` caps how many pages the board takes;
 * the client sets it from the room's remaining page capacity.
 */
export interface ImportPlacement {
  insertIndex: number;
  reuseFrameId?: string;
  maxPages?: number;
}

export function parseImportPlacement(url: URL): ImportPlacement | null {
  const insertIndexParam = url.searchParams.get("insertIndex");
  if (insertIndexParam === null) return null;
  const insertIndex = Number(insertIndexParam);
  if (!Number.isSafeInteger(insertIndex) || insertIndex < 0) return null;
  const placement: ImportPlacement = { insertIndex };

  const reuseFrameId = url.searchParams.get("reuseFrameId");
  if (reuseFrameId !== null) {
    if (!reuseFrameId.startsWith("shape:") || reuseFrameId.length > 256) return null;
    placement.reuseFrameId = reuseFrameId;
  }

  const maxPages = url.searchParams.get("maxPages");
  if (maxPages !== null) {
    const parsed = Number(maxPages);
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > PDF_MAX_RENDER_PAGES) return null;
    placement.maxPages = parsed;
  }
  return placement;
}

function computeImportedPdfFrameHeight(page: { width: number; height: number }): number | null {
  if (
    !Number.isFinite(page.width) ||
    !Number.isFinite(page.height) ||
    page.width <= 0 ||
    page.height <= 0
  ) {
    return null;
  }
  const rawHeight = Math.round((WHITEBOARD_CONFIG.PAGE_WIDTH * page.height) / page.width);
  if (!Number.isFinite(rawHeight)) return null;
  return Math.min(MAX_IMPORTED_FRAME_HEIGHT, Math.max(1, rawHeight));
}

/** The room's description of one rendered, uploaded page. */
export function importedPageSpec(
  importId: string,
  pageIndex: number,
  rendered: { width: number; height: number },
  uploaded: { r2Key: string; size: number },
  source?: { fileId: string; pageNumber: number },
): ImportedPdfPageSpec | null {
  const frameHeight = computeImportedPdfFrameHeight(rendered);
  if (frameHeight === null) return null;
  return {
    pageIndex,
    r2Key: uploaded.r2Key,
    size: uploaded.size,
    sourceWidth: rendered.width,
    sourceHeight: rendered.height,
    frameHeight,
    fileName: `pdf-import-${importId}.pdf`.slice(0, MAX_IMPORTED_FILE_NAME_LENGTH),
    ...(source ? { sourceFileId: source.fileId, sourcePageNumber: source.pageNumber } : {}),
  };
}

// The render cap (-w/-h) already bounds mutool's output, so this is an
// invariant check: a violation means the file is not the PNG we rendered.
// Reject rather than clamp — clamped dimensions would silently distort the
// page's aspect ratio everywhere downstream (frame height, image placement).
const MAX_PNG_DIMENSION = 16384;

export function readPngDimensions(buf: Uint8Array): { width: number; height: number } {
  if (buf.byteLength < 24) {
    throw new Error(`PNG header too short: ${buf.byteLength} bytes (need >= 24)`);
  }
  const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (pngSignature.some((byte, index) => buf[index] !== byte)) {
    throw new Error("Rendered page has an invalid PNG signature");
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (width < 1 || height < 1 || width > MAX_PNG_DIMENSION || height > MAX_PNG_DIMENSION) {
    throw new Error(`PNG dimensions out of range: ${width}x${height}`);
  }
  return { width, height };
}

export function isPdf(buf: Uint8Array): boolean {
  if (buf.length < 4) return false;
  return buf[0] === PDF_MAGIC[0]
    && buf[1] === PDF_MAGIC[1]
    && buf[2] === PDF_MAGIC[2]
    && buf[3] === PDF_MAGIC[3];
}

/** An import's id: a UUID. */
const PDF_IMPORT_JOB_PATH = /^\/([0-9a-f-]{36})$/;

/** `/pdf-import` starts an import; `/pdf-import/<id>` reads or cancels one. */
export function parsePdfImportPath(pathname: string): { type: "start" } | { type: "job"; id: string } | null {
  const prefix = WHITEBOARD_SYNC_ROUTES.pdfImport;
  if (pathname === prefix) return { type: "start" };
  if (!pathname.startsWith(`${prefix}/`)) return null;
  const match = PDF_IMPORT_JOB_PATH.exec(pathname.slice(prefix.length));
  return match ? { type: "job", id: match[1] } : null;
}
