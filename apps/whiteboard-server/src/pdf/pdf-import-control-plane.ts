import { openAsBlob } from "node:fs";
import { buildR2Client } from "../persistence/r2.ts";
import { logError } from "../lib/log.ts";

export { buildR2Client };
import { PDF_MAX_IMPORT_SIZE } from "@orbmeet/whiteboard-core/pdf-geometry";
import { mapWithConcurrency } from "@orbmeet/primitives";
import type { PdfImportGrantConfig, R2UploadConfig, StoredPdfSource } from "./pdf-import-jobs.ts";
import { postSignedJson } from "../http/app-client.ts";

/**
 * What an import asks of the app, and what it puts in R2. Every grant call is
 * one signed POST to the app's PDF import grant (apps/web
 * whiteboard-pdf-import-grant.ts), which decides who may import and keeps the
 * storage quota and the asset registry:
 *
 * - `preflight` reserves quota for the import, resolves a stored source, and
 *   names the key prefix its pages go under;
 * - `commit` registers uploaded pages as the board's assets, before the room
 *   shows them, so nothing on the board is ever outside the registry;
 * - `release` retires registered pages that never reached the board and frees
 *   the reservation.
 */

const R2_REQUEST_TIMEOUT_MS = 30_000;
const UPLOAD_CONCURRENCY = 4;
const GRANT_PATH = "/api/whiteboard/pdf-import-grant";

export interface UploadedPage {
  r2Key: string;
  size: number;
}

/** A grant the app refused or could not be asked for, with the status to report. */
export class GrantRefused extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function grantRequest(id: string, config: PdfImportGrantConfig, body: Record<string, unknown>) {
  return postSignedJson(
    new URL(GRANT_PATH, config.appUrl),
    {
      meetingId: config.meetingSid,
      connectionId: config.connectionId,
      participantIdentity: config.participantIdentity,
      importId: id,
      ...body,
    },
    config.callbackKeyring,
    15_000,
  );
}

async function refusal(response: Response, phase: string): Promise<GrantRefused> {
  const detail = await response.text().catch(() => "");
  logError(`PDF import ${phase} grant failed`, { status: response.status, detail: detail.slice(0, 1_000) });
  if (response.status === 403 && /quota/i.test(detail)) {
    return new GrantRefused(403, "Storage quota exceeded");
  }
  return new GrantRefused(
    response.status >= 400 ? response.status : 502,
    phase === "preflight" ? "Failed to reserve PDF import quota" : "Could not save the imported pages",
  );
}

const SAFE_KEY = /^[A-Za-z0-9._/-]+$/;

function isSafeKey(key: unknown): key is string {
  return typeof key === "string"
    && key.length > 0
    && key.length <= 512
    && SAFE_KEY.test(key)
    && !key.split("/").some((segment) => segment === "." || segment === "..");
}

export async function requestPdfImportPreflight(
  id: string,
  input: { reserveBytes: number } | { sourceFileId: string },
  config: PdfImportGrantConfig,
): Promise<{ uploadPrefix: string; source?: StoredPdfSource }> {
  const response = await grantRequest(id, config, { phase: "preflight", ...input });
  if (!response.ok) throw await refusal(response, "preflight");

  const grant = await response.json().catch(() => null) as
    | { uploadPrefix?: unknown; source?: { r2Key?: unknown; size?: unknown } }
    | null;
  const uploadPrefix = grant?.uploadPrefix;
  if (!isSafeKey(uploadPrefix) || !uploadPrefix.endsWith("/")) {
    throw new GrantRefused(502, "PDF import grant returned an invalid upload destination");
  }
  if ("reserveBytes" in input) return { uploadPrefix };

  const source = grant?.source;
  const size = source?.size;
  if (
    !isSafeKey(source?.r2Key)
    || typeof size !== "number"
    || !Number.isSafeInteger(size)
    || size <= 0
    || size > PDF_MAX_IMPORT_SIZE
  ) {
    throw new GrantRefused(502, "PDF import grant returned an invalid source");
  }
  return { uploadPrefix, source: { r2Key: source.r2Key, size } };
}

export async function requestPdfImportCommit(
  id: string,
  config: PdfImportGrantConfig,
  pages: readonly UploadedPage[],
): Promise<void> {
  const response = await grantRequest(id, config, { phase: "commit", pages });
  if (!response.ok) throw await refusal(response, "commit");
}

export async function requestPdfImportRelease(
  id: string,
  config: PdfImportGrantConfig,
  placedKeys: readonly string[],
  sourceFileId?: string,
): Promise<void> {
  const response = await grantRequest(id, config, {
    phase: "release",
    placedKeys,
    ...(sourceFileId ? { sourceFileId } : {}),
  });
  if (!response.ok) throw await refusal(response, "release");
}

export async function uploadPages(
  pages: ReadonlyArray<{ path: string; r2Key: string }>,
  r2Config: R2UploadConfig,
): Promise<UploadedPage[]> {
  const { client: r2, endpoint } = buildR2Client(r2Config);
  return mapWithConcurrency(pages, UPLOAD_CONCURRENCY, async ({ path, r2Key }) => {
    // A file-backed Blob: read as it is sent, and again if aws4fetch retries.
    const file = await openAsBlob(path, { type: "image/png" });
    const response = await r2.fetch(new URL(`/${r2Config.bucketName}/${r2Key}`, endpoint).toString(), {
      method: "PUT",
      headers: { "Content-Type": "image/png", "Content-Length": String(file.size) },
      body: file,
      signal: AbortSignal.timeout(R2_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(detail || `R2 upload failed (${response.status})`);
    }
    return { r2Key, size: file.size };
  });
}

/** Remove uploads no registry row will ever own (a commit the app refused). */
export async function deletePages(keys: readonly string[], r2Config: R2UploadConfig): Promise<void> {
  const { client: r2, endpoint } = buildR2Client(r2Config);
  await mapWithConcurrency(keys, UPLOAD_CONCURRENCY, async (r2Key) => {
    const response = await r2.fetch(new URL(`/${r2Config.bucketName}/${r2Key}`, endpoint).toString(), {
      method: "DELETE",
      signal: AbortSignal.timeout(R2_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok && response.status !== 404) {
      throw new Error(`R2 delete failed (${response.status})`);
    }
  });
}
