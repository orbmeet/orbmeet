import { createDb, type Database } from "@orbmeet/db";
import { verifySessionFromRawRequest } from "@/modules/identity/server/session";
import { canManagePastMeeting } from "@/modules/meetings/server/access/access-assertions";
import { replaceMeetingWhiteboardPdfMetadata } from "@/modules/assets/server/register";
import { enqueueR2ObjectCleanup } from "@/modules/assets/server/r2-cleanup.server";
import {
  buildR2Client,
  PRESIGNED_R2_UPLOAD_SIGN_OPTIONS,
} from "@/modules/assets/server/r2-client.server";
import {
  meetingWhiteboardHandoutKey,
  stagingWhiteboardPdfKey,
} from "@/platform/storage/r2-keys";
import { RequestBodyTooLargeError, readRequestBodyBytes } from "@/platform/http/request-body";
import { buildPresignedUploadHeaders } from "@/modules/assets/server/upload-headers";
import { runSerially, type SerialResults, type SerialTask } from "@/app/serial/serial";
import { logWarn } from "@/lib/logger";
import { resolveMeetingEntitlement } from "@/modules/billing/server/entitlements.server";
import { storagePrincipalKey } from "@/modules/assets/server/storage";
import {
  releaseUploadReservation,
  reserveUploadBytes,
} from "@/modules/assets/server/upload-reservations";
import { promoteImmutableUpload } from "@/modules/assets/server/immutable-upload";
import {
  promotionIntentKey,
  writePromotionIntent,
} from "@/modules/assets/server/promotion-intent";
import { AppError, Errors } from "@/lib/app-errors";
import { enforceWhiteboardAssetRateLimit } from "@/platform/http/rate-limit.server";

const MAX_PDF_BYTES = 100 * 1024 * 1024;
const MAX_CONTROL_BODY_BYTES = 4 * 1024;
const MEETING_ID_RE = /^[a-zA-Z0-9_-]+$/;
const UPLOAD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PDF_SIGNATURE = [0x25, 0x50, 0x44, 0x46, 0x2d] as const; // "%PDF-"

function handoutReservationScope(meetingId: string): string {
  return `meeting-whiteboard-pdf:${meetingId}`;
}

async function readControlBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const bytes = await readRequestBodyBytes(request, MAX_CONTROL_BODY_BYTES);
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return value !== null && typeof value === "object"
      ? value as Record<string, unknown>
      : null;
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) throw error;
    return null;
  }
}

/**
 * Two-phase, direct-to-R2 PDF upload.
 *
 * The Worker only authorizes a small grant request and verifies five ranged
 * bytes during finalize. The PDF body never enters Worker memory or CPU time.
 */
export async function handlePdfUpload(request: Request, env: Env): Promise<Response> {
  await enforceWhiteboardAssetRateLimit(env, request);

  const session = await verifySessionFromRawRequest(request, env);
  if (!session) return new Response("Unauthorized", { status: 401 });

  const url = new URL(request.url);
  const meetingId = url.searchParams.get("meetingId") ?? "";
  const phase = url.searchParams.get("phase");
  if (!meetingId || !MEETING_ID_RE.test(meetingId)) {
    return new Response("Invalid meetingId", { status: 400 });
  }
  if (phase !== "grant" && phase !== "finalize") {
    return new Response("Invalid upload phase", { status: 400 });
  }

  const db = createDb(env.DB);
  const meeting = await db.query.meetings.findFirst({
    where: { id: meetingId },
  });
  if (!meeting) return new Response("Meeting not found", { status: 404 });
  if (!(await canManagePastMeeting(db, meeting, session.userId))) {
    return new Response("Forbidden", { status: 403 });
  }
  const usages = await db.query.meetingWhiteboards.findMany({
    where: { meetingId },
    columns: { whiteboardId: true, captureStatus: true, capturedRevisionId: true },
  });
  if (
    meeting.status !== "ended" ||
    usages.length === 0 ||
    usages.some((usage) =>
      usage.captureStatus !== "captured" || !usage.capturedRevisionId
    )
  ) {
    return new Response("Meeting Whiteboards are not captured", { status: 409 });
  }
  let body: Record<string, unknown> | null;
  try {
    body = await readControlBody(request);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return new Response("Payload too large", { status: 413 });
    }
    throw error;
  }
  const fileSize = body?.fileSize;
  if (
    typeof fileSize !== "number" ||
    !Number.isSafeInteger(fileSize) ||
    fileSize <= 0 ||
    fileSize > MAX_PDF_BYTES
  ) {
    return new Response("Invalid PDF size", { status: 400 });
  }

  if (phase === "grant") {
    if (!env.R2_BUCKET_NAME) {
      return new Response("Storage not configured", { status: 503 });
    }
    const uploadId = crypto.randomUUID();
    const entitlement = await resolveMeetingEntitlement(db, meeting);
    const reservationPrincipal = storagePrincipalKey(entitlement.billingPrincipal);
    const reservationScope = handoutReservationScope(meetingId);
    try {
      await reserveUploadBytes(db, {
        id: uploadId,
        principal: entitlement.billingPrincipal,
        scope: reservationScope,
        bytes: fileSize,
        limitBytes: entitlement.limits.maxStorageBytes,
      });
    } catch (error) {
      if (error instanceof Error && error.message === "upload_quota_exceeded") {
        return new Response("Storage quota exceeded", { status: 403 });
      }
      throw error;
    }
    const r2Key = stagingWhiteboardPdfKey(meetingId, uploadId);
    try {
      const { r2, endpoint } = buildR2Client(env);
      const uploadUrl = new URL(`/${env.R2_BUCKET_NAME}/${r2Key}`, endpoint);
      uploadUrl.searchParams.set("X-Amz-Expires", "600");
      const headers = buildPresignedUploadHeaders({
        mimeType: "application/pdf",
        fileSize,
      });
      const signed = await r2.sign(
        new Request(uploadUrl, { method: "PUT", headers }),
        PRESIGNED_R2_UPLOAD_SIGN_OPTIONS,
      );
      return Response.json({ uploadId, uploadUrl: signed.url });
    } catch (error) {
      await releaseUploadReservation(db, {
        id: uploadId,
        principal: reservationPrincipal,
        scope: reservationScope,
      }).catch(() => undefined);
      throw error;
    }
  }

  const uploadId = body?.uploadId;
  if (typeof uploadId !== "string" || !UPLOAD_ID_RE.test(uploadId)) {
    return new Response("Invalid uploadId", { status: 400 });
  }
  const published = await runSerially(env, {
    kind: "publishMeetingWhiteboardPdf",
    meetingId,
    uploadId,
    fileSize,
    userId: session.userId,
  }, { callerWaits: true });
  switch (published.kind) {
    case "published":
      return Response.json({ r2Key: published.r2Key });
    case "quota_exceeded":
      return new Response("Storage quota exceeded", { status: 403 });
    case "invalid":
      return new Response("Uploaded PDF failed validation", { status: 400 });
  }
}

type PublishOutcome = SerialResults["publishMeetingWhiteboardPdf"];

/**
 * Promote an uploaded PDF to the Meeting's handout and register it, replacing
 * the previous one. Runs in the Meeting's serial scope, so two publishes never
 * interleave their promotion and registration.
 */
export async function publishMeetingWhiteboardPdf(
  db: Database,
  env: Env,
  { meetingId, uploadId, fileSize, userId }: Extract<SerialTask, { kind: "publishMeetingWhiteboardPdf" }>,
): Promise<PublishOutcome> {
  const meeting = await db.query.meetings.findFirst({ where: { id: meetingId } });
  if (!meeting) throw Errors.NOT_FOUND("Meeting");
  const stagedR2Key = stagingWhiteboardPdfKey(meetingId, uploadId);
  const entitlement = await resolveMeetingEntitlement(db, meeting);
  const reservationPrincipal = storagePrincipalKey(entitlement.billingPrincipal);
  const reservationScope = handoutReservationScope(meetingId);
  const r2Key = meetingWhiteboardHandoutKey(meetingId, uploadId);
  let stagingCleanupReady = false;
  try {
    // The reconciliation intent is durable before promotion (same rationale as
    // Space PDFs): the permanent handout key exists before its meeting_artifacts
    // row commits, and a death between the two must leave a trace the
    // promotion-intent sweep can reconcile.
    await writePromotionIntent(env.R2_BUCKET, {
      finalKey: r2Key,
      context: { meetingId: meeting.id, publishId: uploadId },
    });
    const completeObject = await promoteImmutableUpload(env.R2_BUCKET, {
      stagingKey: stagedR2Key,
      finalKey: r2Key,
      owner: uploadId,
      mimeType: "application/pdf",
      expectedSize: fileSize,
      maxSize: MAX_PDF_BYTES,
      signature: PDF_SIGNATURE,
      beforePromote: async (inspectedObject) => {
        // Refresh the grant reservation and bind it to R2's authoritative
        // generation before that generation is copied. The helper then uses
        // its ETag as an If-Match fence, closing the validation/copy race.
        await reserveUploadBytes(db, {
          id: uploadId,
          principal: entitlement.billingPrincipal,
          scope: reservationScope,
          bytes: inspectedObject.size,
          limitBytes: entitlement.limits.maxStorageBytes,
        });
      },
    });
    // The exact inspected generation is now immutable at its final key. The
    // staging copy is no longer needed even if metadata commit becomes
    // ambiguous; a retry finds the owner-tagged final object.
    stagingCleanupReady = true;
    const previousR2Key = await replaceMeetingWhiteboardPdfMetadata(db, {
      meetingId: meeting.id,
      revisionId: null,
      type: "whiteboard_pdf",
      r2Key,
      filename: "whiteboard-export.pdf",
      mimeType: "application/pdf",
      size: completeObject.size,
      uploadedByUserId: userId,
    });
    // Best-effort: a marker that survives a successful commit is retired by
    // the promotion-intent sweep, which finds the registered row.
    await env.R2_BUCKET.delete(promotionIntentKey(r2Key)).catch(() => undefined);
    if (previousR2Key && previousR2Key !== r2Key) {
      await enqueueR2ObjectCleanup(db, [previousR2Key]).catch(async (error) => {
        logWarn("[whiteboard-pdf] Failed to enqueue superseded handout cleanup", {
          meetingId,
          r2Key: previousR2Key,
          error,
        });
        await env.R2_BUCKET.delete(previousR2Key).catch((deleteError) => {
          logWarn("[whiteboard-pdf] Failed to delete superseded handout", {
            meetingId,
            r2Key: previousR2Key,
            error: deleteError,
          });
        });
      });
    }
    return { kind: "published", r2Key };
  } catch (error) {
    if (error instanceof Error && error.message === "upload_quota_exceeded") {
      stagingCleanupReady = true;
      return { kind: "quota_exceeded" };
    }
    if (error instanceof AppError && error.statusCode === 400) {
      stagingCleanupReady = true;
      return { kind: "invalid" };
    }
    throw error;
  } finally {
    await Promise.allSettled([
      ...(stagingCleanupReady ? [env.R2_BUCKET.delete(stagedR2Key)] : []),
      releaseUploadReservation(db, {
        id: uploadId,
        principal: reservationPrincipal,
        scope: reservationScope,
      }),
    ]);
  }
}
