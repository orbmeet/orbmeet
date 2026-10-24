import type { TLShapeId } from "tldraw";
import type { PageManager } from "../pages/page-manager";
import { WHITEBOARD_CONFIG } from "@orbmeet/whiteboard-core/config";
import { PDF_MAX_IMPORT_SIZE, PDF_MAX_RENDER_PAGES } from "@orbmeet/whiteboard-core/pdf-geometry";
import { WHITEBOARD_SYNC_ROUTES, whiteboardPdfImportRoute } from "@orbmeet/whiteboard-core/protocol";
import { whiteboardSyncUrl } from "../sync/service-endpoints";
import { PdfImportPartialError } from "./pdf-import-partial-error";

/**
 * Import a PDF onto the whiteboard.
 *
 * The whiteboard server does the whole import (whiteboard-server
 * pdf-import.ts): it renders the pages and places them on the board in
 * batches, so they appear for everyone, this client included, through sync.
 * This only starts the import, reports its progress, and cancels it if the
 * caller aborts.
 */

type PdfInsertPosition =
  | { type: "before"; page: number }
  | { type: "after"; page: number }
  | { type: "on"; page: number };

export interface PdfImportResult {
  pagesImported: number;
  pagesFailed: number;
}

interface PdfPageRange {
  start: number;
  end: number;
}

interface PdfImportBaseOptions {
  pageManager: PageManager;
  whiteboardUrl: string;
  token: string;
  onProgress?: (current: number, total: number) => void;
  insertPosition?: PdfInsertPosition;
  pageRange?: PdfPageRange;
  signal?: AbortSignal;
}

export type PdfImportOptions = PdfImportBaseOptions & (
  | { file: File; sourceFileId?: never }
  | {
      /** Render an authorized Space file directly from R2. */
      sourceFileId: string;
      file?: never;
    }
);

interface ImportStatus {
  state: "importing" | "done" | "failed";
  pageCount: number;
  placedCount: number;
  error?: string;
}

const POLL_MS = 400;
const IMPORT_DEADLINE_MS = 5 * 60 * 1000;

/** How many more pages the board can take at `insertPosition`. */
function getPdfImportPageCapacity(pageManager: PageManager, insertPosition?: PdfInsertPosition): number {
  const existingPages = pageManager.getPages();
  const availableNewPages = Math.max(0, WHITEBOARD_CONFIG.MAX_PAGES - existingPages.length);
  if (insertPosition?.type === "on" && existingPages[Math.max(0, insertPosition.page - 1)]) {
    return availableNewPages + 1;
  }
  return availableNewPages;
}

/** Where the first page goes: an index to insert before, or a page frame to replace. */
function resolveInsertPlacement(
  pageManager: PageManager,
  insertPosition?: PdfInsertPosition,
): { insertIndex: number; reuseFrameId: TLShapeId | null } {
  const existingPages = pageManager.getPages();
  if (!insertPosition) return { insertIndex: existingPages.length, reuseFrameId: null };
  if (insertPosition.type === "before") {
    return { insertIndex: Math.max(0, insertPosition.page - 1), reuseFrameId: null };
  }
  if (insertPosition.type === "after") {
    return { insertIndex: Math.min(existingPages.length, insertPosition.page), reuseFrameId: null };
  }
  const targetPage = existingPages[Math.max(0, insertPosition.page - 1)];
  return targetPage
    ? { insertIndex: insertPosition.page, reuseFrameId: targetPage.id }
    : { insertIndex: existingPages.length, reuseFrameId: null };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason instanceof Error ? signal!.reason : new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function readStatus(url: string, token: string, signal?: AbortSignal): Promise<ImportStatus | null> {
  try {
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal });
    if (!response.ok) return null;
    return await response.json() as ImportStatus;
  } catch (error) {
    if (signal?.aborted) throw error;
    // A dropped poll is not a failed import; the next one asks again.
    return null;
  }
}

export async function importPdfToWhiteboard(opts: PdfImportOptions): Promise<PdfImportResult> {
  const { file, pageManager, whiteboardUrl, token, sourceFileId, onProgress, insertPosition, pageRange, signal } = opts;

  if (pageRange) {
    if (
      !Number.isSafeInteger(pageRange.start) ||
      !Number.isSafeInteger(pageRange.end) ||
      pageRange.start < 1 ||
      pageRange.end < pageRange.start
    ) {
      throw new Error("Choose a valid PDF page range.");
    }
    if (pageRange.end - pageRange.start + 1 > PDF_MAX_RENDER_PAGES) {
      throw new Error(`Select at most ${PDF_MAX_RENDER_PAGES} PDF pages at a time.`);
    }
  }
  if (file) {
    if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
      throw new Error("File must be a PDF");
    }
    if (file.size > PDF_MAX_IMPORT_SIZE) throw new Error("PDF must be smaller than 50MB");
  }

  const capacity = getPdfImportPageCapacity(pageManager, insertPosition);
  if (capacity <= 0) throw new Error("No pages could be inserted (whiteboard page limit reached).");
  const placement = resolveInsertPlacement(pageManager, insertPosition);

  const startUrl = new URL(whiteboardSyncUrl(whiteboardUrl, WHITEBOARD_SYNC_ROUTES.pdfImport));
  startUrl.searchParams.set("insertIndex", String(placement.insertIndex));
  if (placement.reuseFrameId) startUrl.searchParams.set("reuseFrameId", placement.reuseFrameId);
  startUrl.searchParams.set("maxPages", String(Math.min(capacity, PDF_MAX_RENDER_PAGES)));
  if (pageRange) {
    startUrl.searchParams.set("pageStart", String(pageRange.start));
    startUrl.searchParams.set("pageEnd", String(pageRange.end));
  }

  const started = await fetch(startUrl.toString(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": sourceFileId ? "application/json" : "application/pdf",
    },
    body: sourceFileId ? JSON.stringify({ sourceFileId }) : file,
    signal,
  });
  const start = await started.json().catch(() => null) as { id?: string; pageCount?: number; error?: string } | null;
  if (!started.ok || !start?.id || typeof start.pageCount !== "number") {
    throw new Error(start?.error ?? `Server import failed (${started.status})`);
  }

  const statusUrl = whiteboardSyncUrl(whiteboardUrl, whiteboardPdfImportRoute(start.id));
  const deadline = Date.now() + IMPORT_DEADLINE_MS;
  let placed = 0;
  let timedOut = false;
  try {
    for (;;) {
      await sleep(POLL_MS, signal);
      const status = await readStatus(statusUrl, token, signal);
      if (status) {
        placed = status.placedCount;
        onProgress?.(placed, status.pageCount);
        if (status.state === "done") {
          return { pagesImported: placed, pagesFailed: Math.max(0, start.pageCount - placed) };
        }
        if (status.state === "failed") {
          const error = new Error(status.error ?? "Failed to import PDF");
          throw placed > 0 ? new PdfImportPartialError(placed, error) : error;
        }
      }
      if (Date.now() > deadline) {
        timedOut = true;
        const error = new Error("PDF import timed out.");
        throw placed > 0 ? new PdfImportPartialError(placed, error) : error;
      }
    }
  } catch (error) {
    if (signal?.aborted || timedOut) {
      // The server stops before its next batch; pages already placed stay.
      void fetch(statusUrl, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
    }
    throw error;
  }
}
