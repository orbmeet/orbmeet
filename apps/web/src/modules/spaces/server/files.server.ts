import "@tanstack/react-start/server-only";
import type * as v from "valibot";
import type { Database } from "@orbmeet/db";
import { files } from "@orbmeet/db/schema";
import { and, desc, eq, gt, lt, lte, or } from "drizzle-orm";
import { buildPresignedUploadHeaders } from "@/modules/assets/server/upload-headers";
import type { AuthFnContext } from "@/app/bootstrap/middleware";
import { Errors } from "@/lib/app-errors";
import { generateId } from "@/lib/ids";
import { decodeKeysetCursor, encodeKeysetCursor } from "@/lib/keyset-cursor";
import { commitSpacePdfUpload } from "@/modules/assets/server/finalize-space-pdf";
import { buildR2Client, PRESIGNED_R2_UPLOAD_SIGN_OPTIONS } from "@/modules/assets/server/r2-client.server";
import { signDownloadUrl } from "@/modules/assets/server/signed-urls.server";
import { storagePrincipalKey } from "@/modules/assets/server/storage";
import { releaseUploadReservation, reserveUploadBytes } from "@/modules/assets/server/upload-reservations";
import { loadSpaceEntitlement } from "@/modules/billing/server/entitlements.server";
import type { deleteFileSchema, getFileDownloadUrlSchema, listFilesSchema } from "@/modules/spaces/contract/schemas";
import { getRunChanges, withD1Retry } from "@/platform/database/db-utils";
import { enforceRateLimit } from "@/platform/http/rate-limit.server";
import { spaceUploadKey, stagingSpacePdfKey } from "@/platform/storage/r2-keys";
import { assertSpaceCapability, retainsSpaceManagerSql } from "./helpers";
import {
  MAX_SPACE_PDF_BYTES,
  type FinalizePdfFileUploadInput,
  type GrantPdfFileUploadInput,
  type ListInsertablePdfsInput,
} from "./files.functions";

/**
 * The Space a Whiteboard belongs to, for callers that hold only a board id.
 *
 * Insert PDF runs inside the Whiteboard, which knows its document but has no
 * business knowing which Space owns it. Membership in that Space is clause 1 of
 * whiteboard authorization, so resolving it here keeps the check in one place.
 */
async function resolveWhiteboardSpaceForFiles(
  db: Database,
  whiteboardId: string,
  userId: string,
): Promise<string> {
  const board = await db.query.whiteboards.findFirst({
    where: { id: whiteboardId, status: "active" },
    columns: { spaceId: true },
  });
  if (!board) throw Errors.NOT_FOUND("Whiteboard");
  await assertSpaceCapability(db, board.spaceId, userId, "canView").catch(() => {
    throw Errors.NOT_FOUND("Whiteboard");
  });
  return board.spaceId;
}

/**
 * PDFs already filed in this Whiteboard's Space, for "Insert PDF → choose from
 * this Space's files".
 *
 * A Meeting's Whiteboard export is an output, not a reusable source file.
 */
export async function listInsertablePdfsImpl({
  data,
  context: { user, db },
}: {
  data: ListInsertablePdfsInput;
  context: AuthFnContext;
}) {
  const spaceId = await resolveWhiteboardSpaceForFiles(db, data.whiteboardId, user.id);
  const rows = await db.query.files.findMany({
    where: {
      RAW: (row) =>
        and(
          eq(row.spaceId, spaceId),
          eq(row.type, "pdf"),
          eq(row.status, "committed"),
          gt(row.size, 0),
          lte(row.size, MAX_SPACE_PDF_BYTES),
        )!,
    },
    columns: { id: true, filename: true, size: true, createdAt: true },
    orderBy: { createdAt: "desc" },
    limit: 100,
  });
  return {
    files: rows.map((row) => ({
      id: row.id,
      filename: row.filename,
      size: row.size,
      createdAt: row.createdAt.toISOString(),
    })),
  };
}

export async function listFilesImpl({
  data,
  context: { user, db },
}: {
  data: v.InferOutput<typeof listFilesSchema>;
  context: AuthFnContext;
}) {
  // Match getSpace/listSpaceMeetings: membership is the boundary, so this
  // endpoint does not reveal whether an arbitrary private space id exists.
  await assertSpaceCapability(db, data.spaceId, user.id, "canView");

  const cursor = data.cursor ? decodeKeysetCursor(data.cursor) : null;
  if (data.cursor && !cursor) throw Errors.VALIDATION("Invalid file cursor");

  const limit = data.limit;
  const rows = await db.query.files.findMany({
    where: {
      RAW: (row) =>
        and(
          eq(row.spaceId, data.spaceId),
          eq(row.status, "committed"),
          cursor
            ? or(lt(row.createdAt, cursor.at), and(eq(row.createdAt, cursor.at), lt(row.id, cursor.id)))
            : undefined,
        )!,
    },
    orderBy: (table) => [desc(table.createdAt), desc(table.id)],
    limit: limit + 1,
  });
  const hasMore = rows.length > limit;
  const files = hasMore ? rows.slice(0, limit) : rows;
  const last = files.at(-1);
  const nextCursor = hasMore && last ? encodeKeysetCursor({ at: last.createdAt, id: last.id }) : undefined;

  return { files, nextCursor };
}

export async function getFileDownloadUrlImpl({
  data,
  context: { user, env, db },
}: {
  data: v.InferOutput<typeof getFileDownloadUrlSchema>;
  context: AuthFnContext;
}) {
  await enforceRateLimit(env, `file:download:${user.id}`);
  const file = await db.query.files.findFirst({
    where: { id: data.fileId, status: "committed" },
  });
  if (!file) throw Errors.NOT_FOUND("File");
  await assertSpaceCapability(db, file.spaceId, user.id, "canView");
  return signDownloadUrl(env, file);
}

/**
 * Remove a reusable source from the Space library.
 *
 * Imported Whiteboard pages own their rendered assets, so deleting the source
 * file does not rewrite existing Whiteboards. The row enters a durable
 * `deleting` state first; maintenance removes the R2 object and metadata.
 */
export async function deleteFileImpl({
  data,
  context: { user, db },
}: {
  data: v.InferOutput<typeof deleteFileSchema>;
  context: AuthFnContext;
}) {
  const file = await db.query.files.findFirst({
    where: { id: data.fileId, status: "committed" },
    columns: { id: true, spaceId: true, uploadedByUserId: true },
  });
  if (!file) throw Errors.NOT_FOUND("File");

  const access = await assertSpaceCapability(db, file.spaceId, user.id, "canView");
  if (file.uploadedByUserId !== user.id && !access.capabilities.canManage) {
    throw Errors.FORBIDDEN("Only the uploader or a Space administrator can remove this File.");
  }

  const now = new Date();
  // D1/Drizzle persists timestamp-mode dates as whole seconds. Advancing to
  // the next representable second guarantees the strict expiresAt > createdAt
  // invariant even when commit and deletion happen in the same second.
  const deletingAt = new Date((Math.floor(now.getTime() / 1_000) + 1) * 1_000);
  const result = await withD1Retry(
    () =>
      db
        .update(files)
        .set({
          status: "deleting",
          expiresAt: deletingAt,
        })
        .where(
          and(
            eq(files.id, file.id),
            eq(files.spaceId, file.spaceId),
            eq(files.status, "committed"),
            or(eq(files.uploadedByUserId, user.id), retainsSpaceManagerSql(file.spaceId, user.id)),
          ),
        ),
    { idempotent: true },
  );
  if (getRunChanges(result) === 0) {
    throw Errors.CONFLICT("This File changed before it could be removed.");
  }
  return { success: true };
}

/**
 * A grant is the uploader's alone: the reservation names who asked for it, so
 * only they can finalize the File it becomes and be recorded as its owner.
 */
const spacePdfUploadReservationScope = (spaceId: string, userId: string) =>
  `space-pdf:${spaceId}:${userId}`;

/**
 * Presign a direct-to-R2 PUT for a PDF the user is filing in a Space.
 *
 * `space_assets` is documented as "PDF imports for the whiteboard" and had no
 * writer at all: the whiteboard rasterized every import and discarded the
 * source, so the Files tab could never show it and next week's class had to
 * re-upload from disk. This grant is paired with `finalizePdfFileUpload`, which
 * re-authorizes, reads the object's real size, and atomically consumes the
 * quota reservation while registering the row.
 *
 * The key is derived here from a freshly minted asset id, never accepted from
 * the client, so a grant can only ever write inside this Space's uploads
 * prefix — the shape `space_assets_r2_key_check` enforces at the table.
 */
export async function grantPdfFileUploadImpl({
  data,
  context: { user, db, env },
}: {
  data: GrantPdfFileUploadInput;
  context: AuthFnContext;
}) {
  const spaceId = await resolveWhiteboardSpaceForFiles(db, data.whiteboardId, user.id);
  if (!env.R2_BUCKET_NAME) throw Errors.CONFIG_ERROR("Storage not configured");
  await enforceRateLimit(env, `asset:pdf-grant:${user.id}`);

  const entitlement = await loadSpaceEntitlement(db, spaceId);

  const assetId = generateId("ASSET");
  const reservationPrincipal = storagePrincipalKey(entitlement.billingPrincipal);
  const reservationScope = spacePdfUploadReservationScope(spaceId, user.id);
  try {
    await reserveUploadBytes(db, {
      id: assetId,
      principal: entitlement.billingPrincipal,
      scope: reservationScope,
      bytes: data.fileSize,
      limitBytes: entitlement.limits.maxStorageBytes,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "upload_quota_exceeded") {
      throw Errors.PLAN_LIMIT_REACHED("Storage quota exceeded");
    }
    throw error;
  }

  const r2Key = stagingSpacePdfKey(spaceId, assetId);
  try {
    const { r2, endpoint } = buildR2Client(env);
    const url = new URL(`/${env.R2_BUCKET_NAME}/${r2Key}`, endpoint);
    url.searchParams.set("X-Amz-Expires", "600");
    const headers = buildPresignedUploadHeaders({
      mimeType: "application/pdf",
      fileSize: data.fileSize,
    });
    const signed = await r2.sign(
      new Request(url, { method: "PUT", headers }),
      PRESIGNED_R2_UPLOAD_SIGN_OPTIONS,
    );
    return { assetId, uploadUrl: signed.url, headers };
  } catch (error) {
    await releaseUploadReservation(db, {
      id: assetId,
      principal: reservationPrincipal,
      scope: reservationScope,
    }).catch(() => undefined);
    throw error;
  }
}

/**
 * Register a PDF the client has just PUT to its presigned URL.
 *
 * The key is rebuilt from the same `(spaceId, assetId)` the grant derived it
 * from rather than accepted from the caller, and the size recorded is the one
 * R2 reports — not the one the client claimed at grant time.
 */
export async function finalizePdfFileUploadImpl({
  data,
  context: { user, db, env },
}: {
  data: FinalizePdfFileUploadInput;
  context: AuthFnContext;
}) {
  const spaceId = await resolveWhiteboardSpaceForFiles(db, data.whiteboardId, user.id);
  const stagedR2Key = stagingSpacePdfKey(spaceId, data.assetId);
  const r2Key = spaceUploadKey(spaceId, data.assetId, "pdf");
  const entitlement = await loadSpaceEntitlement(db, spaceId);
  const reservationPrincipal = storagePrincipalKey(entitlement.billingPrincipal);
  const reservationScope = spacePdfUploadReservationScope(spaceId, user.id);
  await enforceRateLimit(env, `asset:pdf-finalize:${user.id}`);

  const existing = await db.query.files.findFirst({ where: { id: data.assetId } });
  if (existing) {
    if (
      existing.spaceId !== spaceId ||
      existing.uploadedByUserId !== user.id ||
      existing.r2Key !== r2Key
    ) {
      throw Errors.FORBIDDEN();
    }
    return { fileId: data.assetId };
  }

  const reservation = await db.query.uploadReservations.findFirst({
    where: { id: data.assetId, principal: reservationPrincipal, scope: reservationScope },
    columns: { bytes: true, expiresAt: true },
  });
  if (!reservation || reservation.expiresAt <= new Date())
    throw Errors.CONFLICT("Upload reservation expired");
  // Promote + commit under a durable reconciliation intent: a death between
  // promotion and metadata commit leaves a recoverable trace the maintenance
  // sweep resolves, instead of a permanent object nothing can account for.
  await commitSpacePdfUpload(db, env.R2_BUCKET, {
    assetId: data.assetId,
    whiteboardId: data.whiteboardId,
    spaceId,
    filename: data.filename,
    owner: user.id,
    stagedR2Key,
    r2Key,
    reservationPrincipal,
    reservationScope,
    expectedSize: reservation.bytes,
    maxSize: MAX_SPACE_PDF_BYTES,
  });
  return { fileId: data.assetId };
}
