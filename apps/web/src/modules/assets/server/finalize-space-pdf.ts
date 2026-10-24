import type { Database } from "@orbmeet/db";
import { promoteImmutableUpload } from "./immutable-upload";
import { promotionIntentKey, writePromotionIntent } from "./promotion-intent";
import { commitReservedFileMetadata } from "./register";

const PDF_SIGNATURE = [0x25, 0x50, 0x44, 0x46, 0x2d] as const; // "%PDF-"

/**
 * Turn a reserved, staged Space PDF into a permanent object plus its metadata —
 * in that accountability order.
 *
 * The reconciliation intent is written FIRST so the permanent key can never
 * exist without a trace: `promoteImmutableUpload` creates the object before
 * `commitReservedFileMetadata` commits the row, and a worker dying between the
 * two would otherwise strand the object permanently (no row, no lifecycle, no
 * sweep that could see it). With the marker in place, a death before the commit
 * is a recoverable state the promotion-intent sweep reconciles after its grace
 * period; a successful commit retires the marker immediately.
 *
 * The no-compensating-delete property is untouched: a database error here
 * propagates without deleting the final key — the marker stays behind and the
 * sweep, not the request path, is the compensator.
 */
export async function commitSpacePdfUpload(
  db: Database,
  bucket: R2Bucket,
  input: {
    assetId: string;
    /** Links the committed file as the Whiteboard's reusable source when given. */
    whiteboardId?: string;
    spaceId: string;
    filename: string;
    /** The authenticated uploader; the promote validates object ownership against it. */
    owner: string;
    stagedR2Key: string;
    r2Key: string;
    reservationPrincipal: string;
    reservationScope: string;
    /** The reserved byte count the promoted object must match exactly. */
    expectedSize: number;
    maxSize: number;
  },
): Promise<R2Object> {
  await writePromotionIntent(bucket, {
    finalKey: input.r2Key,
    context: { spaceId: input.spaceId, assetId: input.assetId, owner: input.owner },
  });
  const finalObject = await promoteImmutableUpload(bucket, {
    stagingKey: input.stagedR2Key,
    finalKey: input.r2Key,
    owner: input.owner,
    mimeType: "application/pdf",
    maxSize: input.maxSize,
    expectedSize: input.expectedSize,
    signature: PDF_SIGNATURE,
  });
  // Never compensate a database error by deleting the immutable final key:
  // a commit may have succeeded, or another finalizer may be committing it.
  await commitReservedFileMetadata(db, {
    id: input.assetId,
    whiteboardId: input.whiteboardId,
    spaceId: input.spaceId,
    type: "pdf",
    r2Key: input.r2Key,
    filename: input.filename,
    mimeType: "application/pdf",
    size: finalObject.size,
    uploadedByUserId: input.owner,
    createdAt: new Date(),
    reservationPrincipal: input.reservationPrincipal,
    reservationScope: input.reservationScope,
  });
  // Best-effort: a marker that survives a successful commit is retired by the
  // sweep, which finds the registered row and only discards the marker.
  await bucket.delete(promotionIntentKey(input.r2Key)).catch(() => undefined);
  await bucket.delete(input.stagedR2Key).catch(() => undefined);
  return finalObject;
}
