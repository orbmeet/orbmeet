import { mkdir, rm } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import {
  PDF_MAX_RENDER_PAGES,
  estimatePdfImportReserveBytes,
} from "@orbmeet/whiteboard-core/pdf-geometry";
import type { ImportedPdfPageSpec } from "../rooms/room-page-mutations.ts";
import type { ImportedPagesApplyResult } from "../rooms/room-page-commands.ts";
import {
  CLEANUP_INTERVAL_MS,
  type ImportJob,
  type PdfImportGrantConfig,
  type R2UploadConfig,
  checkUserRateLimit,
  expireFinishedJobs,
  hasR2Config,
  jobs,
} from "./pdf-import-jobs.ts";
import { ImportReservation } from "./import-reservation.ts";
import {
  GrantRefused,
  deletePages,
  requestPdfImportCommit,
  requestPdfImportPreflight,
  requestPdfImportRelease,
  uploadPages,
} from "./pdf-import-control-plane.ts";
import { type ImportPlacement, importedPageSpec, parseImportPlacement, parsePdfPageRange } from "./pdf-import-contract.ts";
import { PageRender, RenderFailure, readPdfPageCount, readRenderInput, stagePdfInput } from "./pdf-render.ts";
import { Reply, isSuccess } from "../http/reply.ts";
import { logError } from "../lib/log.ts";

/**
 * A PDF import, run on this node from start to finish.
 *
 * The client starts one with a single request (the PDF, or a stored Space
 * file, and where its pages go) and polls its progress. Here, as mutool
 * finishes pages in order, each batch is uploaded to R2, registered with the
 * app as the board's assets, and inserted into the room, so the pages appear
 * for everyone while later ones still render. Registering before inserting is
 * what keeps every page on the board inside the asset registry, whatever
 * happens to this process afterwards; a crash costs at most a batch registered
 * but never shown. When the import ends, however it ends, one release retires
 * registered pages the board does not hold and frees the quota reservation.
 */

/** The part of a Room an import uses. */
export interface ImportRoom {
  canUserAddPages(userId: string): boolean;
  insertImportedPages(
    userId: string,
    spec: {
      importId: string;
      insertIndex: number;
      pages: ImportedPdfPageSpec[];
      reuse?: { frameId: string; height: number };
      after?: { pageIndex: number };
    },
  ): ImportedPagesApplyResult;
}

export interface PdfImportDeps {
  r2Config?: R2UploadConfig;
  /** The import's room, while it is open. */
  findRoom(): ImportRoom | null;
}

/** A reason the import stopped, worded for the person importing. */
class ImportStopped extends Error {}

const cleanupInterval = setInterval(() => expireFinishedJobs(), CLEANUP_INTERVAL_MS);
cleanupInterval.unref?.();

export function stopPdfImportCleanup(): void {
  clearInterval(cleanupInterval);
}

export async function handlePdfImportStart(
  req: IncomingMessage,
  url: URL,
  grant: PdfImportGrantConfig,
  deps: PdfImportDeps,
): Promise<Reply> {
  if (req.method !== "POST") return Reply.text("Method not allowed", 405);
  const userId = grant.participantIdentity;
  // Every later read or cancel is gated on this id; an unowned import would be
  // open to any authenticated caller.
  if (!userId) return Reply.text("Unauthorized", 401);

  const placement = parseImportPlacement(url);
  if (!placement) return Reply.json({ error: "Invalid import placement" }, 400);
  if (!hasR2Config(deps.r2Config)) {
    return Reply.json({ error: "PDF import storage is not configured" }, 503);
  }
  const r2Config = deps.r2Config;

  const input = await readRenderInput(req, userId, r2Config);
  if ("status" in input) return input;

  const reservation = ImportReservation.admit(userId);
  if (!(reservation instanceof ImportReservation)) return reservation;

  // Whether the app holds a quota reservation, which every refusal from here
  // on gives back (release with no placed pages also retires nothing).
  let reserved = false;
  let handedOff = false;
  const refuse = async (reply: Reply): Promise<Reply> => {
    if (reserved) await requestPdfImportRelease(reservation.id, grant, []).catch(() => {});
    return reply;
  };

  try {
    let preflight: Awaited<ReturnType<typeof requestPdfImportPreflight>>;
    try {
      preflight = await requestPdfImportPreflight(
        reservation.id,
        input.type === "stored"
          ? { sourceFileId: input.fileId }
          : { reserveBytes: estimatePdfImportReserveBytes(input.contentLength) },
        grant,
      );
      reserved = true;
    } catch (error) {
      // A timeout may hide a reservation the app did make: release it anyway.
      reserved = !(error instanceof GrantRefused);
      return await refuse(error instanceof GrantRefused
        ? Reply.json({ error: error.message }, error.status)
        : Reply.json({ error: "Could not authorize PDF import" }, 502));
    }

    await mkdir(reservation.dir, { recursive: true });
    const pdfPath = join(reservation.dir, "input.pdf");
    const staged = await stagePdfInput(req, input, preflight.source, pdfPath);
    if (staged) return await refuse(staged);
    reservation.startRendering();

    // Consumed only after quota accepted the import and the body proved to be
    // a PDF: every refusal before this is work the user never got to start.
    if (!checkUserRateLimit(userId)) {
      return await refuse(Reply.json(
        { error: "Too many PDF imports. Please wait a minute." },
        429,
      ));
    }

    // Gives the real bounds a selected range is checked against. Without it,
    // mutool silently duplicates the last page when asked to render past the end.
    const sourcePageCount = await readPdfPageCount(pdfPath);
    if (sourcePageCount === null || sourcePageCount <= 0) {
      return await refuse(Reply.json({ error: "Not a valid PDF" }, 400));
    }
    const range = parsePdfPageRange(url, sourcePageCount);
    if (!range) {
      return await refuse(Reply.json(
        {
          error: sourcePageCount > PDF_MAX_RENDER_PAGES && !url.searchParams.has("pageStart")
            ? `PDF has ${sourcePageCount} pages. Select a range of at most ${PDF_MAX_RENDER_PAGES} pages.`
            : `Choose a valid page range within this ${sourcePageCount}-page PDF (maximum ${PDF_MAX_RENDER_PAGES} pages).`,
        },
        400,
      ));
    }

    const job: ImportJob = {
      id: reservation.id,
      userId,
      meetingSid: grant.meetingSid,
      grant,
      state: "importing",
      pageCount: Math.min(range.count, placement.maxPages ?? range.count),
      placedCount: 0,
      cancelled: false,
    };
    jobs.set(job.id, job);
    const render = new PageRender(pdfPath, reservation.dir, range);
    handedOff = true;
    void runImport({
      job,
      deps: { ...deps, r2Config },
      render,
      reservation,
      placement,
      uploadPrefix: preflight.uploadPrefix,
      source: input.type === "stored" ? { fileId: input.fileId, firstPage: range.start } : undefined,
    });

    return Reply.json({
      id: job.id,
      pageCount: job.pageCount,
      sourcePageStart: range.start,
      sourcePageCount,
    });
  } catch (error) {
    logError("[pdf-import] unexpected error:", error);
    return await refuse(Reply.json({ error: "Internal error" }, 500));
  } finally {
    if (!handedOff) {
      await rm(reservation.dir, { recursive: true, force: true }).catch(() => {});
      reservation.release();
    }
  }
}

/** The import `id` as its owner may see it, or why not. */
function ownedJob(id: string, userId: string, meetingSid: string): ImportJob | Reply {
  const job = jobs.get(id);
  if (!job) return Reply.text("Not found", 404);
  if (job.userId !== userId || job.meetingSid !== meetingSid) return Reply.text("Forbidden", 403);
  return job;
}

export function handlePdfImportStatus(id: string, grant: PdfImportGrantConfig): Reply {
  const job = ownedJob(id, grant.participantIdentity, grant.meetingSid);
  if ("status" in job) return job;
  job.grant = grant;
  return Reply.json({
    state: job.state,
    pageCount: job.pageCount,
    placedCount: job.placedCount,
    ...(job.error ? { error: job.error } : {}),
  });
}

/** Stop before the next batch; pages already on the board stay. */
export function handlePdfImportCancel(id: string, userId: string, meetingSid: string): Reply {
  const job = ownedJob(id, userId, meetingSid);
  if ("status" in job) return job;
  job.cancelled = true;
  return Reply.empty(204);
}

async function runImport(run: {
  job: ImportJob;
  deps: PdfImportDeps & { r2Config: R2UploadConfig };
  render: PageRender;
  reservation: ImportReservation;
  placement: ImportPlacement;
  uploadPrefix: string;
  source?: { fileId: string; firstPage: number };
}): Promise<void> {
  const { job, deps, render, reservation, placement, uploadPrefix, source } = run;
  const keyOf = (index: number) => `${uploadPrefix}page-${index + 1}.png`;
  const placedKeys: string[] = [];
  let lastPlaced: number | null = null;
  void render.finished.then(() => reservation.finishRendering(), () => reservation.finishRendering());

  try {
    while (job.placedCount < job.pageCount) {
      await render.waitForMore(job.placedCount);
      if (job.cancelled) throw new ImportStopped("PDF import was cancelled");
      const available = Math.min(render.ready.length, job.pageCount);
      // Settled with nothing new: the render failed before the next page.
      if (available <= job.placedCount) {
        await render.finished;
        throw new ImportStopped("PDF render ended early");
      }

      const batch = Array.from({ length: available - job.placedCount }, (_, offset) => job.placedCount + offset);
      const uploaded = await uploadPages(
        batch.map((index) => ({ path: render.ready[index].path, r2Key: keyOf(index) })),
        deps.r2Config,
      );
      try {
        await requestPdfImportCommit(job.id, job.grant, uploaded);
      } catch (error) {
        // Nothing registers these objects, so nothing else would remove them.
        await deletePages(uploaded.map((page) => page.r2Key), deps.r2Config).catch(() => {});
        throw error;
      }

      const room = deps.findRoom();
      if (!room?.canUserAddPages(job.userId)) {
        throw new ImportStopped("Whiteboard edit access is required");
      }
      const pages = batch.map((index, offset) => importedPageSpec(
        job.id,
        index,
        render.ready[index],
        uploaded[offset],
        source ? { fileId: source.fileId, pageNumber: source.firstPage + index } : undefined,
      ));
      if (pages.some((page) => page === null)) throw new ImportStopped("Rendered PDF page dimensions are invalid");
      const specs = pages as ImportedPdfPageSpec[];

      // Only the first batch is positioned by number. Every later one follows
      // the page this import placed last, which the room finds wherever it now
      // is, so pages inserted by someone else meanwhile cannot split the import.
      const result = room.insertImportedPages(job.userId, {
        importId: job.id,
        insertIndex: placement.insertIndex,
        pages: specs,
        ...(lastPlaced === null && placement.reuseFrameId
          ? { reuse: { frameId: placement.reuseFrameId, height: specs[0].frameHeight } }
          : {}),
        ...(lastPlaced === null ? {} : { after: { pageIndex: lastPlaced } }),
      });
      // What the room says is on the board decides, not the status code: a
      // partial apply is a rejection that still placed pages.
      for (const index of result.placedPageIndices) placedKeys.push(keyOf(index));
      job.placedCount += result.placedPageIndices.length;
      if (result.placedPageIndices.length > 0) lastPlaced = result.placedPageIndices.at(-1)!;
      if (!isSuccess(result.reply)) {
        const error = (result.reply.json as { error?: unknown } | undefined)?.error;
        throw new ImportStopped(typeof error === "string" ? error : "Could not add the PDF pages to the whiteboard");
      }
    }
    job.state = "done";
  } catch (error) {
    job.state = "failed";
    job.error = error instanceof ImportStopped || error instanceof RenderFailure || error instanceof GrantRefused
      ? error.message
      : "Failed to import PDF";
    if (!(error instanceof ImportStopped)) logError(`[pdf-import] Import ${job.id} failed:`, error);
  } finally {
    render.stop();
    await render.finished.catch(() => {});
    try {
      await requestPdfImportRelease(job.id, job.grant, placedKeys, placedKeys.length > 0 ? source?.fileId : undefined);
    } catch (error) {
      // The reservation lapses on its own; unplaced registered pages stay
      // until the board is deleted.
      logError(`[pdf-import] Release for ${job.id} failed:`, error);
    }
    await rm(reservation.dir, { recursive: true, force: true }).catch(() => {});
    reservation.release();
    job.finishedAt = Date.now();
  }
}
