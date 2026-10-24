/**
 * Server implementations behind the RPC declarations in this directory.
 * Split from the sibling RPC file so the declaration file carries no
 * DB/Drizzle imports and stays safe to include in client route graphs.
 */

import { createDb } from "@orbmeet/db";
import { AppError, Errors } from "@/lib/app-errors";
import { generateId } from "@/lib/ids";
import { getGuestCookieSecret } from "@/modules/meetings/server/access/guest-cookie.server";
import { verifyGuestAdmissionBySecret } from "@/modules/meetings/server/access/guest-admission";
import { requireAuth } from "@/modules/identity/server/session";
import { getEnv } from "@/platform/runtime/server-runtime.server";
import { getClientIP } from "@/platform/http/client-ip.server";
import { enforceRateLimit } from "@/platform/http/rate-limit.server";
import { stagingKey } from "@/platform/storage/r2-keys";
import { promoteImmutableUpload } from "@/modules/assets/server/immutable-upload";
import { promotionIntentKey, writePromotionIntent } from "@/modules/assets/server/promotion-intent";
import { storagePrincipalKey } from "@/modules/assets/server/storage";
import { assertActiveMeetingParticipantWithSpaceAccess, assertMeetingExists } from "@/modules/meetings/server/access/access-assertions";
import { assertSpaceCapability } from "@/modules/spaces/server/helpers";
import { buildWhiteboardAssetApiPath, buildWhiteboardDocumentAssetKey, extractWhiteboardDocumentAssetIdentity, extractWhiteboardAssetKeyFromViewerUrl } from "@orbmeet/whiteboard-core/whiteboard-asset-key";
import { buildPresignedUploadHeaders } from "@/modules/assets/server/upload-headers";
import { getActiveWhiteboardParticipantAccess } from "@/modules/whiteboards/server/meeting/access";
import { releaseUploadReservation, releaseUploadReservationStatement, reserveUploadBytes } from "@/modules/assets/server/upload-reservations";
import { getRunChanges, withD1Retry } from "@/platform/database/db-utils";
import { completeWhiteboardAssetDeletion, commitWhiteboardAssetStatement, createPendingWhiteboardAsset, requestWhiteboardAssetDeletion, type WhiteboardAssetUploader } from "@/modules/whiteboards/server/assets";
import { canUserEditWhiteboardDocument, findMeetingWhiteboardDocument } from "@/modules/whiteboards/server/documents";
import { whiteboardImageHeaderValidation } from "@/modules/whiteboards/server/upload-image-format";
import { MAX_WHITEBOARD_FILE_SIZE, WHITEBOARD_ALLOWED_MIME_TYPES } from "./uploads.functions";
import type { WhiteboardUploadInput } from "./uploads.functions";
import type { FinalizeWhiteboardUploadInput } from "./uploads.functions";
import { loadSpaceEntitlement } from "@/modules/billing/server/entitlements.server";
import { buildR2Client, PRESIGNED_R2_UPLOAD_SIGN_OPTIONS } from "@/modules/assets/server/r2-client.server";

const MAX_GUEST_WHITEBOARD_FILE_SIZE = 10 * 1024 * 1024;
const EXTENSION_BY_MIME_TYPE: Record<(typeof WHITEBOARD_ALLOWED_MIME_TYPES)[number], string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

export async function getWhiteboardUploadUrlImpl({
  data,
}: {
  data: WhiteboardUploadInput;
}) {
  // Establish the caller class before any resource or entitlement lookup.
  // Meeting uploads may instead use an admission-scoped guest cookie, which
  // is verified below once that admission has been resolved.
  let authenticatedUser: Awaited<ReturnType<typeof requireAuth>> | null = null;
  try {
    authenticatedUser = await requireAuth();
  } catch (error) {
    if (!data.meetingId || !(error instanceof AppError && error.code === "UNAUTHORIZED")) {
      throw error;
    }
  }

  const env = await getEnv();
  const db = createDb(env.DB);
  // The reservation is keyed by the asset id, not a separate client-held
  // token. finalize looks the asset up by its r2Key and releases the
  // reservation under that same id, so a stale or misrouted token can never
  // free a different in-flight reservation of the same principal and leak this
  // one for the full TTL.
  const assetId = generateId("WHITEBOARD_ASSET");

  let uploader: WhiteboardAssetUploader;
  // Set only once bytes are actually reserved, so the cleanup below releases
  // exactly the reservation this request holds and never a phantom one.
  let reservationPrincipal: string | null = null;

  let document: { whiteboardId: string; syncRoomId: string; spaceId: string };
  if (data.meetingId) {
    await assertMeetingExists(db, data.meetingId, { requireActive: true });
    const meetingDocument = await findMeetingWhiteboardDocument(db, data.meetingId);
    if (!meetingDocument || meetingDocument.whiteboardId !== data.whiteboardId) {
      throw Errors.FORBIDDEN();
    }
    document = meetingDocument;
  } else {
    const standaloneDocument = await db.query.whiteboards.findFirst({
      where: { id: data.whiteboardId, status: "active" },
      columns: { id: true, syncRoomId: true, spaceId: true },
    });
    if (!standaloneDocument) throw Errors.FORBIDDEN();
    document = {
      whiteboardId: standaloneDocument.id,
      syncRoomId: standaloneDocument.syncRoomId,
      spaceId: standaloneDocument.spaceId,
    };
  }
  const entitlement = await loadSpaceEntitlement(db, document.spaceId);
  const storagePrincipal = storagePrincipalKey(entitlement.billingPrincipal);

  if (!data.meetingId) {
    const user = authenticatedUser;
    if (!user) throw Errors.UNAUTHORIZED();
    uploader = { uploadedByUserId: user.id, guestAdmissionId: null };
    await enforceRateLimit(env, `upload:${user.id}`);
    if (!(await canUserEditWhiteboardDocument(db, data.whiteboardId, user.id))) {
      throw Errors.FORBIDDEN();
    }
  } else if (authenticatedUser) {
    const user = authenticatedUser;
    uploader = { uploadedByUserId: user.id, guestAdmissionId: null };
    if (!data.connectionId) throw Errors.UNAUTHORIZED();
    await enforceRateLimit(env, `upload:${user.id}`);

    await assertActiveMeetingParticipantWithSpaceAccess(db, data.meetingId, user.id);
    const access = await getActiveWhiteboardParticipantAccess(
      db,
      data.meetingId,
      data.connectionId,
    );
    if (!access || access.userId !== user.id) throw Errors.FORBIDDEN();
    if (!access.canEditWhiteboard) throw Errors.FORBIDDEN("Whiteboard edit access is required");
  } else {
    if (!data.connectionId) throw Errors.UNAUTHORIZED();
    if (data.fileSize > MAX_GUEST_WHITEBOARD_FILE_SIZE) {
      throw Errors.PLAN_LIMIT_REACHED("Guest whiteboard uploads are limited to 10 MB");
    }

    const access = await getActiveWhiteboardParticipantAccess(
      db,
      data.meetingId,
      data.connectionId,
    );
    if (!access || access.userId !== null || !access.admissionId) throw Errors.FORBIDDEN();
    await verifyGuestAdmissionBySecret(
      db,
      data.meetingId,
      access.admissionId,
      getGuestCookieSecret(access.admissionId),
    );
    if (!access.canEditWhiteboard) throw Errors.FORBIDDEN("Whiteboard edit access is required");
    uploader = { uploadedByUserId: null, guestAdmissionId: access.admissionId };

    await enforceRateLimit(env, `upload:ip:${getClientIP()}`);
    await enforceRateLimit(env, `upload:guest:${access.admissionId}`);
  }

  try {
    await reserveUploadBytes(db, {
      id: assetId,
      principal: entitlement.billingPrincipal,
      scope: `whiteboard:${data.whiteboardId}`,
      bytes: data.fileSize,
      limitBytes: entitlement.limits.maxStorageBytes,
    });
    reservationPrincipal = storagePrincipal;
  } catch (reservationError) {
    if (reservationError instanceof Error && reservationError.message === "upload_quota_exceeded") {
      throw Errors.PLAN_LIMIT_REACHED(
        uploader.guestAdmissionId
          ? "Guest whiteboard upload quota exceeded"
          : "Storage quota exceeded",
      );
    }
    throw reservationError;
  }

  const safeName = data.filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  const safeR2Key = buildWhiteboardDocumentAssetKey(
    data.whiteboardId,
    assetId,
    EXTENSION_BY_MIME_TYPE[data.mimeType],
  );

  // Everything past this point runs with bytes already reserved, and the
  // caller only learns the reservation id from a successful return. A throw
  // in here — the pending-asset insert, the R2 client import, the signing
  // call — would otherwise leave the reservation counting against the
  // principal's quota until its 10-minute TTL expires, with nothing able to
  // release it.
  // The enclosing try/catch above is the guest-fallback branch, not cleanup.
  try {
    await createPendingWhiteboardAsset(db, {
      id: assetId,
      whiteboardId: data.whiteboardId,
      spaceId: document.spaceId,
      r2Key: safeR2Key,
      filename: safeName,
      mimeType: data.mimeType,
      size: data.fileSize,
      uploader,
    });

    const { r2, endpoint } = buildR2Client(env);
    const url = new URL(
      `/${env.R2_BUCKET_NAME}/${stagingKey(`whiteboard-${data.whiteboardId}`, assetId)}`,
      endpoint,
    );
    url.searchParams.set("X-Amz-Expires", "600");

    const headers = buildPresignedUploadHeaders({
      mimeType: data.mimeType,
      fileSize: data.fileSize,
      md5Hash: data.md5Hash,
    });

    const signed = await r2.sign(
      new Request(url.toString(), {
        method: "PUT",
        headers,
      }),
      PRESIGNED_R2_UPLOAD_SIGN_OPTIONS,
    );

    return {
      uploadUrl: signed.url,
      assetUrl: buildWhiteboardAssetApiPath(safeR2Key),
    };
  } catch (setupError) {
    if (reservationPrincipal) {
      await releaseUploadReservation(db, {
        id: assetId,
        principal: reservationPrincipal,
        scope: `whiteboard:${data.whiteboardId}`,
      }).catch(() => {
        // Best effort: the TTL is the backstop. Never mask the real failure.
      });
    }
    throw setupError;
  }
}

export async function finalizeWhiteboardUploadImpl({
  data,
}: {
  data: FinalizeWhiteboardUploadInput;
}) {
  const env = await getEnv();
  const db = createDb(env.DB);
  const r2Key = extractWhiteboardAssetKeyFromViewerUrl(data.assetUrl);
  let callerOwnerId: string | null = null;
  let participantIdentity: string | null = null;
  let callerCanEdit = false;
  let reservationPrincipal: string | null = null;

  if (!r2Key) throw Errors.FORBIDDEN();
  const assetIdentity = extractWhiteboardDocumentAssetIdentity(r2Key);
  if (!assetIdentity || assetIdentity.whiteboardId !== data.whiteboardId) {
    throw Errors.FORBIDDEN();
  }
  const asset = await db.query.whiteboardAssets.findFirst({
    where: { r2Key, whiteboardId: data.whiteboardId },
    columns: {
      id: true,
      size: true,
      mimeType: true,
      status: true,
      uploadedByUserId: true,
      guestAdmissionId: true,
    },
  });
  if (!asset) throw Errors.FORBIDDEN();
  let document: { whiteboardId: string; syncRoomId: string; spaceId: string };
  if (data.meetingId) {
    const meetingDocument = await findMeetingWhiteboardDocument(db, data.meetingId);
    if (!meetingDocument || meetingDocument.whiteboardId !== data.whiteboardId) {
      throw Errors.FORBIDDEN();
    }
    document = meetingDocument;
  } else {
    const standaloneDocument = await db.query.whiteboards.findFirst({
      where: { id: data.whiteboardId },
      columns: { id: true, syncRoomId: true, spaceId: true, status: true },
    });
    if (!standaloneDocument) throw Errors.FORBIDDEN();
    if (data.action === "commit" && standaloneDocument.status !== "active") {
      throw Errors.FORBIDDEN();
    }
    document = {
      whiteboardId: standaloneDocument.id,
      syncRoomId: standaloneDocument.syncRoomId,
      spaceId: standaloneDocument.spaceId,
    };
  }
  reservationPrincipal = storagePrincipalKey(
    (await loadSpaceEntitlement(db, document.spaceId)).billingPrincipal,
  );

  if (!data.meetingId) {
    const user = await requireAuth();
    if (data.action === "commit") {
      await assertSpaceCapability(db, document.spaceId, user.id, "canView");
      if (!(await canUserEditWhiteboardDocument(db, data.whiteboardId, user.id))) {
        throw Errors.FORBIDDEN();
      }
    }
    callerOwnerId = user.id;
    participantIdentity = user.id;
    // Standalone editing authority is Space membership, checked above for
    // the commit that needs it.
    callerCanEdit = true;
  } else {
    try {
      const user = await requireAuth();
      if (!data.connectionId) throw Errors.UNAUTHORIZED();
      await assertMeetingExists(db, data.meetingId, { requireActive: true }).then((meeting) =>
        assertActiveMeetingParticipantWithSpaceAccess(db, meeting.id, user.id, { meeting }),
      );
      const access = await getActiveWhiteboardParticipantAccess(
        db,
        data.meetingId,
        data.connectionId,
      );
      if (!access || access.userId !== user.id) throw Errors.FORBIDDEN();
      callerOwnerId = user.id;
      participantIdentity = access.participantIdentity;
      callerCanEdit = access.canEditWhiteboard;
    } catch (err) {
      if (!(err instanceof AppError && err.code === "UNAUTHORIZED")) throw err;
      if (!data.connectionId) throw Errors.UNAUTHORIZED();
      const access = await getActiveWhiteboardParticipantAccess(
        db,
        data.meetingId,
        data.connectionId,
      );
      if (!access || access.userId !== null || !access.admissionId) {
        throw Errors.FORBIDDEN();
      }
      callerOwnerId = `guest-${access.admissionId}`;
      participantIdentity = access.participantIdentity;
      callerCanEdit = access.canEditWhiteboard;
      await verifyGuestAdmissionBySecret(
        db,
        data.meetingId,
        access.admissionId,
        getGuestCookieSecret(access.admissionId),
      );
    }
  }

  const callerOwnsAsset = callerOwnerId?.startsWith("guest-")
    ? asset.guestAdmissionId === callerOwnerId.slice("guest-".length)
    : asset.uploadedByUserId === callerOwnerId;
  if (!callerOwnerId || !reservationPrincipal || !callerOwnsAsset) {
    throw Errors.FORBIDDEN();
  }

  // Commit and rollback each move the row out of `pending` in one statement,
  // so whichever lands first decides, for a second finalizer and for
  // maintenance alike. An object a losing commit promoted is left to the
  // promotion-intent sweep.
  const uploadStagingKey = stagingKey(`whiteboard-${data.whiteboardId}`, asset.id);

  // Status was read above; cleanup may have moved pending → deleting since.
  const current = await db.query.whiteboardAssets.findFirst({
    where: { id: asset.id, r2Key, whiteboardId: data.whiteboardId },
    columns: { status: true },
  });
  if (!current) throw Errors.FORBIDDEN();
  if (data.action === "rollback") {
    const deletion = await requestWhiteboardAssetDeletion(db, {
      id: asset.id,
      whiteboardId: data.whiteboardId,
      from: "pending",
    });
    // A commit may have succeeded even if its response was lost. Rollback is
    // then an idempotent no-op and must never delete committed bytes.
    if (deletion !== "committed" && deletion !== "missing") {
      await env.R2_BUCKET.delete(r2Key);
      await completeWhiteboardAssetDeletion(db, {
        id: asset.id,
        whiteboardId: data.whiteboardId,
      });
    }
  } else {
    if (!participantIdentity) throw Errors.FORBIDDEN();
    // A presigned PUT URL remains usable until expiry. The edit authority
    // resolved above from D1 is current, so a revocation since the upload
    // began refuses this irreversible quota/storage commit; rollback
    // deliberately remains available after revocation.
    if (!callerCanEdit) throw Errors.FORBIDDEN("Whiteboard edit access is required");
    if (current.status === "deleting") {
      throw Errors.VALIDATION("Whiteboard upload is being rolled back");
    }
    let object: R2Object | null;
    if (current.status === "committed") {
      object = await env.R2_BUCKET.head(r2Key);
    } else {
      // The reconciliation intent is durable before promotion (same
      // rationale as Space PDFs): the permanent asset key exists before
      // its whiteboard_assets row commits, and a death between the two
      // must leave a trace the promotion-intent sweep can reconcile.
      await writePromotionIntent(env.R2_BUCKET, {
        finalKey: r2Key,
        context: { whiteboardId: data.whiteboardId, assetId: asset.id },
      });
      object = await promoteImmutableUpload(env.R2_BUCKET, {
        stagingKey: uploadStagingKey,
        finalKey: r2Key,
        owner: asset.id,
        mimeType: asset.mimeType,
        expectedSize: asset.size,
        maxSize: MAX_WHITEBOARD_FILE_SIZE,
        headerValidation: whiteboardImageHeaderValidation(asset.mimeType),
      });
    }
    if (!object || object.size !== asset.size)
      throw Errors.VALIDATION("Whiteboard upload was not found");
    const commit = {
      id: asset.id,
      whiteboardId: data.whiteboardId,
      r2Key,
      size: object.size,
    };
    const reservation = {
      id: asset.id,
      principal: reservationPrincipal,
      scope: `whiteboard:${data.whiteboardId}`,
    };
    const [commitResult] = await withD1Retry(
      () =>
        db.batch([
          commitWhiteboardAssetStatement(db, commit),
          releaseUploadReservationStatement(db, reservation),
        ]),
      { idempotent: true },
    );
    if (getRunChanges(commitResult) === 0) {
      const existing = await db.query.whiteboardAssets.findFirst({
        where: { id: asset.id, whiteboardId: data.whiteboardId },
        columns: { r2Key: true, size: true, status: true },
      });
      if (
        existing?.status !== "committed" ||
        existing.r2Key !== r2Key ||
        existing.size !== object.size
      ) {
        throw new Error(`Failed to commit Whiteboard asset ${asset.id}`);
      }
    }
    await env.R2_BUCKET.delete(uploadStagingKey).catch(() => undefined);
    // Best-effort: a marker that survives a successful commit is retired
    // by the promotion-intent sweep, which finds the registered row.
    await env.R2_BUCKET.delete(promotionIntentKey(r2Key)).catch(() => undefined);
    return { success: true };
  }
  await env.R2_BUCKET.delete(uploadStagingKey).catch(() => undefined);
  // Release under the asset's own id — the reservation was made with it, and
  // the asset was resolved from the request's r2Key — so this frees exactly
  // this upload's reservation and never another of the same principal's.
  await releaseUploadReservation(db, {
    id: asset.id,
    principal: reservationPrincipal,
    scope: `whiteboard:${data.whiteboardId}`,
  });
  return { success: true };
}
