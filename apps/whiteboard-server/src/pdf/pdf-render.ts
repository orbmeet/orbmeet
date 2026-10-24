import { open, readdir, stat } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import { Readable } from "node:stream";
import { text } from "node:stream/consumers";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { PDF_MAX_IMPORT_SIZE, isPdfSourceFileId } from "@orbmeet/whiteboard-core/pdf-geometry";
import { header, jsonBodyErrorReply, readBoundedJson, readStreamWithTimeouts } from "../http/http.ts";
import { Reply } from "../http/reply.ts";
import {
  MAX_RENDER_BYTES_PER_JOB,
  type R2UploadConfig,
  type StoredPdfSource,
  capacity,
  checkUploadAttemptRateLimit,
  hasR2Config,
} from "./pdf-import-jobs.ts";
import { buildR2Client } from "./pdf-import-control-plane.ts";
import { type MutoolProcess, mutoolExited, spawnMutool } from "./mutool.ts";
import { isPdf, planRenderShards, readPngDimensions } from "./pdf-import-contract.ts";
import { logError } from "../lib/log.ts";

/**
 * Rendering a PDF's pages to PNGs on this node: reading the PDF in (a request
 * body or a stored Space file), counting its pages, and running mutool over the
 * selected range in parallel shards. pdf-import.ts drives it and places the
 * pages as they finish.
 */

export type PdfRenderInput =
  | { type: "upload"; contentLength: number }
  | { type: "stored"; fileId: string; r2Config: R2UploadConfig };

const RENDER_DPI = 144; // 2× base 72 DPI

// With -r set, mutool treats -w/-h as *maximum* output dimensions and scales
// oversized pages down to fit. PDF pages can legally be 14400×14400pt (28800px
// at 144 DPI ≈ 3.3 GB raster), so without this cap a hostile page OOMs the
// container. 4096px keeps a full-width page crisp on the 1200-unit frame while
// bounding the raster at ~64 MB.
const RENDER_MAX_DIMENSION_PX = 4096;

const RENDER_TIMEOUT_MS = 30_000;
const BODY_READ_IDLE_TIMEOUT_MS = 30_000;

// Applies only to the ad-hoc browser upload fallback; Space files use R2.
const BODY_READ_TOTAL_TIMEOUT_MS = 5 * 60_000;

const R2_SOURCE_READ_TIMEOUT_MS = 5 * 60_000;
const MAX_RENDER_STDERR_BYTES = 64 * 1024;

// Page rasterization is embarrassingly parallel, but a single mutool process
// renders pages serially and its own -P/-B/-T flags barely move (measured: -P
// none, banded threads 1.6x, separate processes 3.8x). Splitting the page range
// across processes is what actually scales, so this is the total mutool process
// budget shared by every in-flight render — keep it at or below the container's
// cpus limit in infra/ops/node/compose.yaml, which is 3. Raising it there
// instead would take a core out of the allocation that keeps the SFU responsive
// under contention, which is not a trade a PDF import gets to make.
const RENDER_PROCESS_BUDGET = 3;

const PAGE_COUNT_TIMEOUT_MS = 10_000;

export async function readPdfPageCount(pdfPath: string): Promise<number | null> {
  const proc = spawnMutool(["info", pdfPath], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const exited = mutoolExited(proc);
  const timer = setTimeout(() => proc.kill("SIGKILL"), PAGE_COUNT_TIMEOUT_MS);
  try {
    const [exitCode, stdout] = await Promise.all([exited, text(proc.stdout!)]);
    if (exitCode !== 0) return null;
    const match = stdout.match(/Pages:\s*(\d+)/);
    if (!match) return null;
    const pageCount = Number(match[1]);
    return Number.isSafeInteger(pageCount) ? pageCount : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    // The timer was the only thing that would ever kill this process, so
    // cancelling it without killing leaks `mutool` for as long as it chooses to
    // run — and the stdout read rejecting is exactly the path where the process
    // is still alive. `kill` on an already-exited process is a no-op.
    proc.kill("SIGKILL");
  }
}


async function writeBodyToFile(
  body: Readable,
  filePath: string,
  maxBytes: number,
): Promise<number> {
  let totalBytes = 0;
  const file = await open(filePath, "w");
  try {
    await readStreamWithTimeouts(
      body,
      {
        idleMs: BODY_READ_IDLE_TIMEOUT_MS,
        totalMs: BODY_READ_TOTAL_TIMEOUT_MS,
      },
      async (chunk) => {
        totalBytes += chunk.byteLength;
        if (totalBytes > maxBytes) throw new Error("payload_too_large");
        await file.write(chunk);
      },
    );
  } finally {
    await file.close();
  }
  return totalBytes;
}

/** The first `bytes` bytes of the file at `path`, and its size. */
async function readFileHead(path: string, bytes: number): Promise<{ head: Buffer; size: number }> {
  const file = await open(path, "r");
  try {
    const { buffer, bytesRead } = await file.read(Buffer.alloc(bytes), 0, bytes, 0);
    return { head: buffer.subarray(0, bytesRead), size: (await file.stat()).size };
  } finally {
    await file.close();
  }
}

async function downloadStoredPdf(
  source: StoredPdfSource,
  filePath: string,
  r2Config: R2UploadConfig,
): Promise<number> {
  const { client: r2, endpoint } = buildR2Client(r2Config);
  const url = new URL(`/${r2Config.bucketName}/${source.r2Key}`, endpoint);
  const response = await r2.fetch(url.toString(), {
    signal: AbortSignal.timeout(R2_SOURCE_READ_TIMEOUT_MS),
  });
  if (response.status === 404) throw new Error("stored_pdf_not_found");
  if (!response.ok) throw new Error("stored_pdf_fetch_failed");
  const contentLength = response.headers.get("Content-Length");
  if (contentLength !== null && Number(contentLength) !== source.size) {
    await response.body?.cancel().catch(() => {});
    throw new Error("stored_pdf_size_mismatch");
  }
  if (!response.body) return 0;
  // fetch is typed with the DOM lib; its body is Node's web stream.
  const body = Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>);
  try {
    return await writeBodyToFile(body, filePath, PDF_MAX_IMPORT_SIZE);
  } finally {
    body.destroy();
  }
}

async function readBoundedProcessStderr(
  stream: Readable | null,
): Promise<{ text: string; exceeded: boolean }> {
  // No pipe was asked for (or the process could not provide one).
  if (!stream) return { text: "", exceeded: false };
  const decoder = new TextDecoder();
  let bytes = 0;
  let output = "";
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    const remaining = MAX_RENDER_STDERR_BYTES - bytes;
    if (remaining > 0) {
      output += decoder.decode(chunk.subarray(0, remaining), { stream: true });
    }
    bytes += chunk.byteLength;
    // Leaving the loop destroys the pipe, so mutool stops being read.
    if (bytes > MAX_RENDER_STDERR_BYTES) return { text: `${output}\n[stderr truncated]`, exceeded: true };
  }
  return { text: output + decoder.decode(), exceeded: false };
}

/** The PDF a render request names: an uploaded body, or a stored Space file — or why it cannot be read. */
export async function readRenderInput(
  req: IncomingMessage,
  userId: string,
  r2Config: R2UploadConfig | undefined,
): Promise<PdfRenderInput | Reply> {
  if (header(req, "Content-Type")?.includes("application/json")) {
    // `readBoundedJson` already rejects a non-object body, so this only has to
    // decide whether the object is exactly the stored-source request.
    let body: Record<string, unknown>;
    try {
      body = await readBoundedJson<Record<string, unknown>>(req);
    } catch (error) {
      return jsonBodyErrorReply(error);
    }
    if (Object.keys(body).length !== 1 || !isPdfSourceFileId(body.sourceFileId)) {
      return Reply.json({ error: "Invalid stored PDF source" }, 400);
    }
    if (!hasR2Config(r2Config)) {
      return Reply.json({ error: "PDF import storage is not configured" }, 503);
    }
    return { type: "stored", fileId: body.sourceFileId, r2Config };
  }

  const contentLength = header(req, "Content-Length");
  if (!contentLength) {
    return Reply.json({ error: "Content-Length header is required" }, 411);
  }
  const parsedContentLength = Number(contentLength);
  if (!Number.isSafeInteger(parsedContentLength) || parsedContentLength < 0) {
    return Reply.json({ error: "Invalid Content-Length header" }, 400);
  }
  if (parsedContentLength > PDF_MAX_IMPORT_SIZE) {
    return Reply.json({ error: "PDF too large (max 50 MB)" }, 413);
  }
  if (parsedContentLength === 0) {
    return Reply.json({ error: "PDF body is required" }, 400);
  }
  // This budget is intentionally distinct from successful render quota: it
  // bounds ingress spent on malformed uploads without penalizing stored-file
  // imports or redefining what counts as a render.
  if (!checkUploadAttemptRateLimit(userId)) {
    return Reply.json(
      { error: "Too many PDF upload attempts. Please wait a minute." },
      429,
    );
  }
  return { type: "upload", contentLength: parsedContentLength };
}

/**
 * Write the import's PDF to `pdfPath` — the request body, or the stored file
 * from R2 — and check it is the PDF it claimed to be. Returns the refusal to
 * send when it is not; the caller removes what was written.
 */
export async function stagePdfInput(
  req: IncomingMessage,
  input: PdfRenderInput,
  storedSource: StoredPdfSource | undefined,
  pdfPath: string,
): Promise<void | Reply> {
  if (input.type === "stored" && !storedSource) throw new Error("Stored PDF grant omitted its source");
  const stored = input.type === "stored" ? { source: storedSource!, r2Config: input.r2Config } : null;
  const expectedBytes = stored ? stored.source.size : (input as { contentLength: number }).contentLength;

  let writtenBytes: number;
  try {
    writtenBytes = stored
      ? await downloadStoredPdf(stored.source, pdfPath, stored.r2Config)
      : await writeBodyToFile(req, pdfPath, PDF_MAX_IMPORT_SIZE);
  } catch (err) {
    const reason = err instanceof Error ? err.message : "";
    if (reason === "payload_too_large") {
      return Reply.json({ error: "PDF too large (max 50 MB)" }, 413);
    }
    if (!stored && reason === "read_timeout") {
      return Reply.json({ error: "Request timeout" }, 408);
    }
    if (stored && reason === "stored_pdf_not_found") {
      return Reply.json({ error: "Stored PDF not found" }, 404);
    }
    if (stored && reason === "stored_pdf_size_mismatch") {
      return Reply.json({ error: "Stored PDF metadata does not match R2" }, 409);
    }
    if (stored) {
      return Reply.json({ error: "Could not read stored PDF" }, 502);
    }
    throw err;
  }
  if (writtenBytes === 0) {
    return Reply.json({ error: "PDF body is required" }, 400);
  }
  if (writtenBytes !== expectedBytes) {
    return Reply.json(
      { error: stored
        ? "Stored PDF size does not match its metadata"
        : "Content-Length does not match the PDF body" },
      stored ? 502 : 400,
    );
  }
  const { head: magic } = await readFileHead(pdfPath, 4);
  if (!isPdf(magic)) {
    return Reply.json({ error: "Not a valid PDF" }, 400);
  }
}

interface RenderShards {
  procs: MutoolProcess[];
  /** Each process's exit code, in `procs` order. */
  exits: Promise<number>[];
  shards: { first: number; last: number }[];
  killAll: (signal?: "SIGKILL") => void;
}

/** Start mutool over `range`, split across processes, writing `${outputPrefix}-<page>.png`. */
function spawnRenderShards(
  pdfPath: string,
  outputPrefix: string,
  range: { start: number; count: number },
): RenderShards {
  // Divide the process budget by the renders already in flight (this one
  // included) so a lone import uses the whole allowance and three concurrent
  // ones fall back to serial. Shard counts are fixed at spawn time, so a
  // render starting after this one can still push the live total briefly
  // above the budget; it bounds the steady state, not every instant.
  const shards = planRenderShards(
    range.count,
    Math.max(1, Math.floor(RENDER_PROCESS_BUDGET / Math.max(1, capacity.activeRenders))),
    range.start,
  );
  const procs = shards.map((shard) => spawnMutool(
    [
      "draw", "-q",
      "-r", String(RENDER_DPI),
      "-w", String(RENDER_MAX_DIMENSION_PX),
      "-h", String(RENDER_MAX_DIMENSION_PX),
      "-F", "png",
      "-o", `${outputPrefix}-%d.png`,
      pdfPath,
      `${shard.first}-${shard.last}`,
    ],
    { stdout: "ignore", stderr: "pipe" },
  ));
  // Taken at spawn, so an exit cannot be missed; a shard whose mutool never
  // started reads as a failed shard rather than an unhandled rejection.
  const exits = procs.map((proc) => mutoolExited(proc));
  for (const exit of exits) exit.catch(() => {});
  const killAll = (signal?: "SIGKILL") => {
    for (const proc of procs) {
      try {
        if (signal) proc.kill(signal);
        else proc.kill();
      } catch {
        // Already exited.
      }
    }
  };
  return { procs, exits, shards, killAll };
}

/** A page whose PNG is final on disk. */
export interface RenderedPage {
  path: string;
  width: number;
  height: number;
  size: number;
}

/** Why a render stopped, worded for the person importing. */
export class RenderFailure extends Error {}

/**
 * A running render of `range`. Pages become ready in order: `ready` only ever
 * lists a prefix of the range, because a later shard can finish before an
 * earlier one and the import places pages in document order.
 *
 * `finished` settles once every shard has exited: resolved when the whole
 * range rendered, rejected with a RenderFailure otherwise.
 */
export class PageRender {
  readonly ready: RenderedPage[] = [];
  readonly finished: Promise<void>;
  #slots: (RenderedPage | undefined)[] = [];
  #settled = false;
  #waiters: (() => void)[] = [];
  #shards: RenderShards;

  private readonly range: { start: number; count: number };

  constructor(pdfPath: string, dir: string, range: { start: number; count: number }) {
    this.range = range;
    this.#shards = spawnRenderShards(pdfPath, join(dir, "page"), range);
    this.finished = this.#drain(dir).finally(() => {
      this.#settled = true;
      this.#wake();
    });
    // Callers read failures through `finished` or `waitForMore`; an import
    // that stops early must not surface the render's rejection as unhandled.
    this.finished.catch(() => {});
  }

  /** Resolve once more than `count` pages are ready or the render has settled. */
  async waitForMore(count: number): Promise<void> {
    while (this.ready.length <= count && !this.#settled) {
      await new Promise<void>((resolve) => this.#waiters.push(resolve));
    }
  }

  /** Stop mutool, for an import that no longer needs the rest. */
  stop(): void {
    this.#shards.killAll("SIGKILL");
  }

  #wake(): void {
    for (const resolve of this.#waiters.splice(0)) resolve();
  }

  async #drain(dir: string): Promise<void> {
    const { procs, exits, shards, killAll } = this.#shards;
    let outputTooLarge = false;
    let measuring = false;
    const outputBudgetTimer = setInterval(() => {
      if (measuring || outputTooLarge) return;
      measuring = true;
      void (async () => {
        try {
          let bytes = 0;
          for (const file of await readdir(dir)) {
            if (!file.endsWith(".png")) continue;
            bytes += (await stat(join(dir, file))).size;
            if (bytes > MAX_RENDER_BYTES_PER_JOB) {
              outputTooLarge = true;
              killAll("SIGKILL");
              break;
            }
          }
        } catch {
          // mutool may be replacing directory entries.
        } finally {
          measuring = false;
        }
      })();
    }, 250);
    outputBudgetTimer.unref?.();

    // One deadline for the whole render, not one per shard: the shards run
    // concurrently, so the wall-clock budget they share is still
    // RENDER_TIMEOUT_MS. mutool can ignore SIGTERM mid-render; escalate to
    // SIGKILL so a wedged process can't pin a render slot until restart.
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
    const deadline = setTimeout(() => {
      killAll();
      forceKillTimer = setTimeout(() => killAll("SIGKILL"), 5_000);
    }, RENDER_TIMEOUT_MS);

    let shardFailure: string | null = null;
    let stderrTooLarge = false;
    try {
      await Promise.all(procs.map((proc, shardIndex) => (async () => {
        const shard = shards[shardIndex];
        let exitCode: number;
        let stderr: string;
        try {
          const [code, bounded] = await Promise.all([exits[shardIndex], readBoundedProcessStderr(proc.stderr)]);
          exitCode = code;
          stderr = bounded.text;
          if (bounded.exceeded) {
            stderrTooLarge = true;
            killAll("SIGKILL");
            return;
          }
        } catch {
          shardFailure ??= `mutool failed for pages ${shard.first}-${shard.last} (unreadable output)`;
          killAll("SIGKILL");
          return;
        }
        if (exitCode !== 0) {
          shardFailure ??= `mutool failed for pages ${shard.first}-${shard.last} (exit ${exitCode}): ${stderr}`;
          return;
        }
        for (let pageNumber = shard.first; pageNumber <= shard.last; pageNumber++) {
          const path = join(dir, `page-${pageNumber}.png`);
          try {
            const { head, size } = await readFileHead(path, 24);
            this.#slots[pageNumber - this.range.start] = { path, ...readPngDimensions(head), size };
          } catch (error) {
            logError(`[pdf-render] Invalid rendered page output (page ${pageNumber}):`, error);
            shardFailure ??= `Rendered page ${pageNumber} could not be processed`;
            return;
          }
        }
        let next = this.#slots[this.ready.length];
        while (next) {
          this.ready.push(next);
          next = this.#slots[this.ready.length];
        }
        this.#wake();
      })()));
    } finally {
      clearTimeout(deadline);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      clearInterval(outputBudgetTimer);
    }

    if (outputTooLarge) throw new RenderFailure("Rendered PDF output is too large");
    if (stderrTooLarge) throw new RenderFailure("PDF renderer produced excessive diagnostic output");
    // Any shard failing means the range is incomplete: the pages before the
    // gap stay usable, the rest is reported.
    if (shardFailure !== null) {
      logError(`[pdf-render] ${String(shardFailure)}`);
      throw new RenderFailure("Failed to render PDF");
    }
    // `count` came from `mutool info` and drove the shard plan; the files came
    // from `mutool draw`. On a malformed PDF the two can disagree, and asked
    // for a page past the end mutool re-renders the last one under the
    // out-of-range number, so a mismatch would be silently duplicated pages.
    if (this.ready.length !== this.range.count) {
      logError(
        `[pdf-render] selected page count mismatch: expected ${this.range.count}, render produced ${this.ready.length}`,
      );
      throw new RenderFailure("PDF page count could not be determined reliably");
    }
  }
}
