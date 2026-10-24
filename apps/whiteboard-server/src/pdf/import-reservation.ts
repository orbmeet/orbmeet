import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { PDF_MAX_IMPORT_SIZE } from "@orbmeet/whiteboard-core/pdf-geometry";
import {
  MAX_ACTIVE_IMPORTS,
  MAX_CONCURRENT_RENDERS,
  MAX_CONCURRENT_UPLOADS,
  MAX_IMPORTS_PER_USER,
  MAX_RENDER_BYTES_PER_JOB,
  MAX_UPLOADS_PER_USER,
  capacity,
  pdfScratchReservationFits,
  reservedRenderDirs,
  scratch,
} from "./pdf-import-jobs.ts";
import { Reply } from "../http/reply.ts";

/** Scratch one import may fill: the largest accepted input plus the most output a render may write. */
const SCRATCH_RESERVATION_BYTES = PDF_MAX_IMPORT_SIZE + MAX_RENDER_BYTES_PER_JOB;

function adjust(counts: Map<string, number>, userId: string, delta: number): void {
  const next = (counts.get(userId) ?? 0) + delta;
  if (next <= 0) counts.delete(userId);
  else counts.set(userId, next);
}

/**
 * The process capacity one PDF import holds, from admission until it
 * finishes: an import slot, an upload slot while the PDF arrives, a render
 * slot (reserved at admission, taken once the upload is on disk, given back
 * when mutool is done), the worst-case scratch space, and the claim on its
 * render directory's name.
 *
 * Each piece is released exactly once. `release()` gives back whatever is
 * still held, so every exit path calls it without knowing how far the import
 * got.
 */
export class ImportReservation {
  readonly id = randomUUID();
  readonly dir = join(scratch.dir, this.id);
  #uploading = true;
  #renderReserved = true;
  #rendering = false;
  #released = false;

  /**
   * Reserve an import for `userId`, or the refusal to send. Every check and
   * every reservation happens with no await between them, so concurrent
   * requests in this process cannot all observe the same free capacity.
   */
  static admit(userId: string): ImportReservation | Reply {
    if (capacity.activeUploads >= MAX_CONCURRENT_UPLOADS) {
      return Reply.json(
        { error: "Server is busy receiving other PDFs. Please try again shortly." },
        503,
      );
    }
    if ((capacity.activeUploadsByUser.get(userId) ?? 0) >= MAX_UPLOADS_PER_USER) {
      return Reply.json(
        { error: "Another PDF upload from this participant is still in progress" },
        429,
      );
    }
    if (capacity.activeImports >= MAX_ACTIVE_IMPORTS) {
      return Reply.json(
        { error: "Too many PDF imports are in progress. Please try again shortly." },
        503,
      );
    }
    if ((capacity.activeImportsByUser.get(userId) ?? 0) >= MAX_IMPORTS_PER_USER) {
      return Reply.json(
        { error: "Finish or cancel an existing PDF import first" },
        429,
      );
    }
    if (capacity.activeRenders + capacity.reservedRenderSlots >= MAX_CONCURRENT_RENDERS) {
      return Reply.json(
        { error: "Server is busy rendering other PDFs. Please try again shortly." },
        503,
      );
    }
    if (!pdfScratchReservationFits(capacity.reservedScratchBytes)) {
      return Reply.json(
        { error: "PDF render scratch storage is busy. Please try again shortly." },
        503,
      );
    }
    return new ImportReservation(userId);
  }

  readonly userId: string;

  private constructor(userId: string) {
    this.userId = userId;
    capacity.activeImports++;
    adjust(capacity.activeImportsByUser, userId, 1);
    capacity.reservedRenderSlots++;
    capacity.reservedScratchBytes += SCRATCH_RESERVATION_BYTES;
    capacity.activeUploads++;
    adjust(capacity.activeUploadsByUser, userId, 1);
    // Claim the directory name before it exists so orphan cleanup cannot
    // delete this import's files while it runs.
    reservedRenderDirs.add(this.id);
  }

  /** The PDF is on disk: trade the upload slot and the render reservation for a render slot. */
  startRendering(): void {
    this.#releaseUpload();
    this.#releaseRenderReservation();
    capacity.activeRenders++;
    this.#rendering = true;
  }

  /** mutool is done; placing the pages needs no render slot. */
  finishRendering(): void {
    if (!this.#rendering) return;
    this.#rendering = false;
    capacity.activeRenders = Math.max(0, capacity.activeRenders - 1);
  }

  /** Give back everything still held. Idempotent. */
  release(): void {
    if (this.#released) return;
    this.#released = true;
    reservedRenderDirs.delete(this.id);
    this.#releaseUpload();
    this.#releaseRenderReservation();
    this.finishRendering();
    capacity.reservedScratchBytes = Math.max(0, capacity.reservedScratchBytes - SCRATCH_RESERVATION_BYTES);
    capacity.activeImports = Math.max(0, capacity.activeImports - 1);
    adjust(capacity.activeImportsByUser, this.userId, -1);
  }

  #releaseUpload(): void {
    if (!this.#uploading) return;
    this.#uploading = false;
    capacity.activeUploads--;
    adjust(capacity.activeUploadsByUser, this.userId, -1);
  }

  #releaseRenderReservation(): void {
    if (!this.#renderReserved) return;
    this.#renderReserved = false;
    capacity.reservedRenderSlots = Math.max(0, capacity.reservedRenderSlots - 1);
  }
}
