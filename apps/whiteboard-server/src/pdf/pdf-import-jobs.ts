import type { Keyring } from "@orbmeet/primitives";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { PDF_MAX_IMPORT_SIZE } from "@orbmeet/whiteboard-core/pdf-geometry";

const DEFAULT_RENDER_SCRATCH_DIR = "/tmp/pdf-render";

/**
 * Root for render output, mutable so a process can be pointed at a private
 * scratch directory. `cleanupOrphanedRenderDirs` deletes every entry this
 * process does not own, so two processes sharing one root would delete each
 * other's in-flight renders — and a test sharing it with the real default
 * inherits whatever a previous run left behind.
 */
export const scratch = { dir: DEFAULT_RENDER_SCRATCH_DIR };

/**
 * Process-wide import budgets. Slots are reserved synchronously before the
 * first await so concurrent requests cannot all pass the check and then all
 * discover the slots were already taken (see ImportReservation).
 */
export const capacity = {
  activeImports: 0,
  activeRenders: 0,
  reservedRenderSlots: 0,
  activeUploads: 0,
  reservedScratchBytes: 0,
  activeImportsByUser: new Map<string, number>(),
  activeUploadsByUser: new Map<string, number>(),
};

/** How long a finished import's outcome stays readable for the client's last poll. */
const FINISHED_JOB_TTL_MS = 10 * 60 * 1000;
export const CLEANUP_INTERVAL_MS = 60 * 1000;

export const MAX_ACTIVE_IMPORTS = 24;
export const MAX_IMPORTS_PER_USER = 3;
export const MAX_RENDER_BYTES_PER_JOB = 256 * 1024 * 1024;

// infra/ops/node/compose.yaml mounts /tmp as 1 GiB. Reserve at most 700 MiB
// for PDF inputs and rendered pages, leaving 324 MiB for process scratch and
// filesystem metadata. Every admitted import reserves the maximum accepted
// input (not the caller-controlled Content-Length) plus the full per-render
// output cap before writing a byte, and holds it until the import finishes.
const MAX_PDF_SCRATCH_BYTES = 700 * 1024 * 1024;

export const MAX_CONCURRENT_RENDERS = 3;
export const MAX_CONCURRENT_UPLOADS = 6;
export const MAX_UPLOADS_PER_USER = 1;

export function pdfScratchReservationFits(reservedBytes: number): boolean {
  return reservedBytes + PDF_MAX_IMPORT_SIZE + MAX_RENDER_BYTES_PER_JOB <= MAX_PDF_SCRATCH_BYTES;
}

const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 5;
const UPLOAD_ATTEMPT_LIMIT = 10;
const userRenderTimestamps = new Map<string, number[]>();
const userUploadAttemptTimestamps = new Map<string, number[]>();

import type { R2Config } from "../persistence/r2.ts";
export type R2UploadConfig = R2Config;
export { hasR2Config } from "../persistence/r2.ts";

/** Who an import acts for, as the app's grant callbacks identify them. */
export interface PdfImportGrantConfig {
  meetingSid: string;
  connectionId: string;
  participantIdentity: string;
  appUrl: string;
  callbackKeyring: Keyring;
}

/** What the client can read about an import while it runs and shortly after. */
export interface ImportJob {
  id: string;
  userId: string;
  meetingSid: string;
  /**
   * Who the grant calls act for. The connection is a renewable lease, not the
   * import's identity: each status poll carries the participant's newest one
   * forward, so an import survives its owner reconnecting.
   */
  grant: PdfImportGrantConfig;
  state: "importing" | "done" | "failed";
  /** Pages the import will place (the selected range, capped by the client). */
  pageCount: number;
  /** Pages on the board so far. */
  placedCount: number;
  error?: string;
  /** Set by the client's cancel; the import stops before its next batch. */
  cancelled: boolean;
  finishedAt?: number;
}

export const jobs = new Map<string, ImportJob>();

// Render directories in use. A render creates its directory before mutool
// runs, so orphan cleanup must skip every directory an import has claimed.
export const reservedRenderDirs = new Set<string>();

export function checkUserRateLimit(userId: string): boolean {
  const now = Date.now();
  const timestamps = userRenderTimestamps.get(userId) ?? [];
  const recent = timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (recent.length >= RATE_LIMIT_MAX_REQUESTS) return false;
  recent.push(now);
  userRenderTimestamps.set(userId, recent);
  return true;
}

export function checkUploadAttemptRateLimit(userId: string): boolean {
  const now = Date.now();
  const timestamps = userUploadAttemptTimestamps.get(userId) ?? [];
  const recent = timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (recent.length >= UPLOAD_ATTEMPT_LIMIT) return false;
  recent.push(now);
  userUploadAttemptTimestamps.set(userId, recent);
  return true;
}

/** Forget finished imports nobody polled, and rate-limit windows that have passed. */
export function expireFinishedJobs(now = Date.now()): void {
  for (const [id, job] of jobs) {
    if (job.finishedAt !== undefined && now - job.finishedAt > FINISHED_JOB_TTL_MS) jobs.delete(id);
  }
  for (const timestamps of [userRenderTimestamps, userUploadAttemptTimestamps]) {
    for (const [userId, times] of timestamps) {
      const fresh = times.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
      if (fresh.length === 0) timestamps.delete(userId);
      else timestamps.set(userId, fresh);
    }
  }
}

/**
 * Drop render directories left behind by a previous process: every entry no
 * in-flight import has claimed.
 */
async function cleanupOrphanedRenderDirs(): Promise<void> {
  try {
    const entries = await readdir(scratch.dir);
    for (const entry of entries) {
      if (!reservedRenderDirs.has(entry)) {
        rm(join(scratch.dir, entry), { recursive: true, force: true }).catch(() => {});
      }
    }
  } catch {
    // The scratch root may not exist yet.
  }
}

/**
 * Point this process at its render scratch root and reap what a previous one
 * left there. Awaited at startup, so an import can never start against a
 * half-reaped root.
 */
export async function initializePdfRenderScratchDir(
  dir: string = DEFAULT_RENDER_SCRATCH_DIR,
): Promise<void> {
  scratch.dir = dir;
  await mkdir(scratch.dir, { recursive: true });
  await cleanupOrphanedRenderDirs();
}

export interface StoredPdfSource {
  r2Key: string;
  size: number;
}
