import "@tanstack/react-start/server-only";

import type { Database } from "@orbmeet/db";
import {
  whiteboardAssetReferences,
  whiteboardAssets,
  whiteboardRevisionAssetReferences,
  whiteboardRevisions,
} from "@orbmeet/db/schema";
import { and, eq, gte, inArray, lt, notExists, or, sql, type SQL } from "drizzle-orm";
import { getRunChanges, withD1Retry } from "@/platform/database/db-utils";
import { boundedStatements } from "@/platform/database/db-batching";
import { generateId } from "@/lib/ids";
import { mapWithConcurrency } from "@orbmeet/primitives";
import { headR2Object } from "@/modules/assets/server/r2-storage";
import {
  extractWhiteboardDocumentAssetIdentity,
  whiteboardPdfImportPrefix,
} from "@orbmeet/whiteboard-core/whiteboard-asset-key";
import { r2KeyBeingDeletedSql } from "@/modules/assets/server/r2-cleanup.server";

const WHITEBOARD_ASSET_PENDING_TTL_MS = 15 * 60 * 1000;

export interface WhiteboardAssetUploader {
  uploadedByUserId: string | null;
  guestAdmissionId: string | null;
}

export interface WhiteboardAssetCommit {
  id: string;
  whiteboardId: string;
  r2Key: string;
  size: number;
  now?: Date;
}

/** Build the guarded commit UPDATE so it can participate in a larger D1 batch. */
export function commitWhiteboardAssetStatement(
  db: Database,
  input: WhiteboardAssetCommit,
  writeFence?: SQL,
) {
  const now = input.now ?? new Date();
  return db.update(whiteboardAssets).set({
    status: "committed",
    size: input.size,
    expiresAt: null,
    committedAt: now,
  }).where(and(
    eq(whiteboardAssets.id, input.id),
    eq(whiteboardAssets.whiteboardId, input.whiteboardId),
    eq(whiteboardAssets.r2Key, input.r2Key),
    eq(whiteboardAssets.status, "pending"),
    eq(whiteboardAssets.size, input.size),
    writeFence,
  ));
}

export async function createPendingWhiteboardAsset(
  db: Database,
  input: {
    id: string;
    whiteboardId: string;
    spaceId: string;
    r2Key: string;
    filename: string;
    mimeType: string;
    size: number;
    uploader: WhiteboardAssetUploader;
    now?: Date;
  },
): Promise<void> {
  const now = input.now ?? new Date();
  await withD1Retry(
    () => db.insert(whiteboardAssets).values({
      id: input.id,
      whiteboardId: input.whiteboardId,
      spaceId: input.spaceId,
      r2Key: input.r2Key,
      filename: input.filename,
      mimeType: input.mimeType,
      size: input.size,
      status: "pending",
      uploadedByUserId: input.uploader.uploadedByUserId,
      guestAdmissionId: input.uploader.guestAdmissionId,
      expiresAt: new Date(now.getTime() + WHITEBOARD_ASSET_PENDING_TTL_MS),
      createdAt: now,
    }).onConflictDoNothing(),
    { idempotent: true },
  );
  const existing = await db.query.whiteboardAssets.findFirst({
    where: { id: input.id, whiteboardId: input.whiteboardId },
    columns: { r2Key: true },
  });
  if (existing?.r2Key !== input.r2Key) {
    throw new Error(`Failed to reserve Whiteboard asset ${input.id}`);
  }
}

export async function commitWhiteboardAsset(
  db: Database,
  input: WhiteboardAssetCommit,
): Promise<void> {
  const result = await withD1Retry(
    () => db.update(whiteboardAssets).set({
      status: "committed",
      // Internal PDF renders reserve deterministic keys before their encoded
      // size is known, so the general helper retains the zero-size sentinel.
      size: input.size,
      expiresAt: null,
      committedAt: input.now ?? new Date(),
    }).where(and(
      eq(whiteboardAssets.id, input.id),
      eq(whiteboardAssets.whiteboardId, input.whiteboardId),
      eq(whiteboardAssets.r2Key, input.r2Key),
      eq(whiteboardAssets.status, "pending"),
      or(eq(whiteboardAssets.size, input.size), eq(whiteboardAssets.size, 0)),
    )),
    { idempotent: true },
  );
  if (getRunChanges(result) > 0) return;
  const existing = await db.query.whiteboardAssets.findFirst({
    where: { id: input.id, whiteboardId: input.whiteboardId },
    columns: { r2Key: true, size: true, status: true },
  });
  if (
    existing?.status !== "committed" ||
    existing.r2Key !== input.r2Key ||
    existing.size !== input.size
  ) {
    throw new Error(`Failed to commit Whiteboard asset ${input.id}`);
  }
}

/**
 * Whether any immutable revision of this board still references `r2Key`.
 *
 * Revision capture writes registry rows for the *same* R2 keys the live
 * document uses — it never copies the objects (unlike the document-copy path,
 * which does duplicate assets into new keys). So a revision's manifest points
 * at live keys, and hard-deleting one from the live board silently invalidated
 * every earlier revision that showed that image: reuse a board across meetings,
 * delete an old image, and a previous meeting's supposedly immutable record
 * renders 404s.
 *
 * The manifest is a JSON array on the revision row, so `json_each` answers this
 * directly — no reference counter to keep consistent across partial failures,
 * no background sweep, and no schema change. Revisions are indexed by board and
 * bounded per board, so the scan stays small.
 */
export async function isWhiteboardAssetReferencedByRevision(
  db: Database,
  input: { whiteboardId: string; r2Key: string },
): Promise<boolean> {
  const referencing = await db.get<{ referenced: number }>(sql`
    SELECT EXISTS (
      SELECT 1
      FROM ${whiteboardRevisionAssetReferences} AS revision_asset
      WHERE revision_asset.r2_key = ${input.r2Key}
      UNION ALL
      SELECT 1
      FROM ${whiteboardRevisions} AS revision,
           json_each(revision.asset_manifest) AS manifest_key
      WHERE revision.asset_manifest IS NOT NULL
        AND manifest_key.value = ${input.r2Key}
        AND (
          revision.whiteboard_id = ${input.whiteboardId}
          OR EXISTS (
            SELECT 1
            FROM ${whiteboardAssetReferences} AS revision_reference
            WHERE revision_reference.whiteboard_id = revision.whiteboard_id
              AND revision_reference.r2_key = ${input.r2Key}
          )
        )
      UNION ALL
      SELECT 1
      FROM ${whiteboardAssetReferences} AS asset_reference
      WHERE asset_reference.r2_key = ${input.r2Key}
    ) AS referenced
  `);
  return referencing?.referenced === 1;
}

/**
 * No revision and no live document names the asset's object. Part of every
 * transition to `deleting`: revision capture pins assets in the same D1 batch
 * as the immutable revision, so testing the references in the transition
 * itself makes "pin wins" atomic with respect to "delete wins".
 */
function assetIsUnreferenced(db: Database): SQL {
  return and(
    notExists(
      db.select({ r2Key: whiteboardRevisionAssetReferences.r2Key })
        .from(whiteboardRevisionAssetReferences)
        .where(eq(whiteboardRevisionAssetReferences.r2Key, whiteboardAssets.r2Key)),
    ),
    notExists(
      db.select({ r2Key: whiteboardAssetReferences.r2Key })
        .from(whiteboardAssetReferences)
        .where(eq(whiteboardAssetReferences.r2Key, whiteboardAssets.r2Key)),
    ),
  )!;
}

/**
 * When an asset entering the deletion saga falls due; `expiresAt` doubles as
 * the maintenance due-at value while deletion is pending. Timestamps are whole
 * seconds, and it must be after the row's creation, which can be this same
 * second for an asset just registered.
 */
function deletionDueAt(now: Date): Date {
  return new Date(now.getTime() + 1_000);
}

/**
 * Durable half of the D1 → R2 deletion saga.
 *
 * The row changes state before the object is deleted. A crash or R2 failure
 * therefore leaves a retryable `deleting` intent instead of either a dangling
 * registry row or untracked retained bytes.
 */
export async function requestWhiteboardAssetDeletion(
  db: Database,
  input: {
    id: string;
    whiteboardId: string;
    from: "pending" | "committed";
    now?: Date;
  },
): Promise<"requested" | "already_deleting" | "committed" | "missing"> {
  const now = input.now ?? new Date();
  const result = await withD1Retry(
    () => db.update(whiteboardAssets).set({
      status: "deleting",
      expiresAt: deletionDueAt(now),
    }).where(and(
      eq(whiteboardAssets.id, input.id),
      eq(whiteboardAssets.whiteboardId, input.whiteboardId),
      eq(whiteboardAssets.status, input.from),
      assetIsUnreferenced(db),
    )),
    { idempotent: true },
  );
  if (getRunChanges(result) > 0) return "requested";
  const existing = await db.query.whiteboardAssets.findFirst({
    where: { id: input.id, whiteboardId: input.whiteboardId },
    columns: { status: true },
  });
  if (!existing) return "missing";
  if (existing.status === "deleting") return "already_deleting";
  if (existing.status === "committed") return "committed";
  throw new Error(`Failed to request deletion for Whiteboard asset ${input.id}`);
}

export async function completeWhiteboardAssetDeletion(
  db: Database,
  input: { id: string; whiteboardId: string },
): Promise<void> {
  await withD1Retry(
    () => db.delete(whiteboardAssets).where(and(
      eq(whiteboardAssets.id, input.id),
      eq(whiteboardAssets.whiteboardId, input.whiteboardId),
      eq(whiteboardAssets.status, "deleting"),
    )),
    { idempotent: true },
  );
}

const PDF_IMPORT_PAGE_NUMBER = /\/page-(\d+)\.png$/;

/**
 * Register a PDF import's uploaded pages as the board's committed assets. The
 * whiteboard server calls this after the upload and before the room shows
 * them, so no page on the board is ever outside the registry. Each page has a
 * fixed row id, so a retried batch inserts nothing twice; a row already there
 * must describe the same object.
 */
export async function commitPdfImportAssets(
  db: Database,
  input: {
    whiteboardId: string;
    spaceId: string;
    importId: string;
    pages: ReadonlyArray<{ r2Key: string; size: number }>;
    uploader: WhiteboardAssetUploader;
    now?: Date;
  },
): Promise<void> {
  const now = input.now ?? new Date();
  const rows = input.pages.map(({ r2Key, size }) => {
    const pageNumber = PDF_IMPORT_PAGE_NUMBER.exec(r2Key)?.[1];
    if (!pageNumber) throw new Error(`Not a PDF import page key: ${r2Key}`);
    return {
      id: `whiteboard_asset_${input.importId}_${pageNumber}`,
      whiteboardId: input.whiteboardId,
      spaceId: input.spaceId,
      r2Key,
      filename: `page-${pageNumber}.png`,
      mimeType: "image/png",
      size,
      status: "committed" as const,
      uploadedByUserId: input.uploader.uploadedByUserId,
      guestAdmissionId: input.uploader.guestAdmissionId,
      expiresAt: null,
      committedAt: now,
      createdAt: now,
    };
  });
  for (const insert of boundedStatements(rows, (chunk) =>
    db.insert(whiteboardAssets).values(chunk).onConflictDoNothing())) {
    await withD1Retry(() => insert, { idempotent: true });
  }
  const byKey = new Map<string, { r2Key: string; status: string; size: number }>();
  for (const lookup of boundedStatements(rows.map((row) => row.r2Key), (r2Keys) =>
    db
      .select({ r2Key: whiteboardAssets.r2Key, status: whiteboardAssets.status, size: whiteboardAssets.size })
      .from(whiteboardAssets)
      .where(and(eq(whiteboardAssets.whiteboardId, input.whiteboardId), inArray(whiteboardAssets.r2Key, r2Keys))))) {
    for (const row of await lookup) byKey.set(row.r2Key, row);
  }
  for (const row of rows) {
    const existing = byKey.get(row.r2Key);
    if (existing?.status !== "committed" || existing.size !== row.size) {
      throw new Error(`Failed to register PDF import page ${row.r2Key}`);
    }
  }
}

/**
 * Retire the pages an import registered but the board never showed: a batch
 * the room refused, or one an import stopped before placing. Placed pages are
 * left alone; everything else enters asset deletion.
 */
export async function retireUnplacedPdfImportAssets(
  db: Database,
  input: { whiteboardId: string; importId: string; placedKeys: readonly string[]; now?: Date },
): Promise<void> {
  const prefix = whiteboardPdfImportPrefix(input.whiteboardId, input.importId);
  const registered = await db.query.whiteboardAssets.findMany({
    where: {
      whiteboardId: input.whiteboardId,
      status: "committed",
      RAW: (row) => and(gte(row.r2Key, prefix), lt(row.r2Key, `${prefix}\uffff`))!,
    },
    columns: { r2Key: true },
  });
  const placed = new Set(input.placedKeys);
  const unplaced = registered.map((row) => row.r2Key).filter((r2Key) => !placed.has(r2Key));
  if (unplaced.length === 0) return;
  await retireWhiteboardAssets(db, { whiteboardId: input.whiteboardId, r2Keys: unplaced, now: input.now });
}

/**
 * Retire committed assets the board no longer holds: each enters the deletion
 * saga, unless a revision or another board names it, in which case it stays
 * committed. The maintenance job re-checks revisions before deleting.
 */
export async function retireWhiteboardAssets(
  db: Database,
  input: { whiteboardId: string; r2Keys: string[]; now?: Date },
): Promise<void> {
  const now = input.now ?? new Date();
  // One statement per chunk, not a lookup and an update per key: this runs
  // inside a recovery callback the whiteboard server abandons after 10s.
  const retirements = boundedStatements(input.r2Keys, (r2Keys) =>
    db.update(whiteboardAssets).set({
      status: "deleting",
      expiresAt: deletionDueAt(now),
    }).where(and(
      eq(whiteboardAssets.whiteboardId, input.whiteboardId),
      inArray(whiteboardAssets.r2Key, r2Keys),
      eq(whiteboardAssets.status, "committed"),
      assetIsUnreferenced(db),
    )));
  for (const retirement of retirements) await withD1Retry(() => retirement, { idempotent: true });
}

/** How many asset objects finalization inspects at once. */
const REVISION_ASSET_CONCURRENCY = 6;

export interface RevisionAssetCommitResult {
  /** Keys backed by a real object and now present in the registry. */
  committedKeys: string[];
  /**
   * Keys referenced by snapshot asset records whose object does not exist. It
   * can include an upload that was rolled back or an object that a lifecycle
   * rule expired.
   */
  missingKeys: string[];
}

/**
 * Finalization is the last authority boundary for a live document. Reconcile
 * every referenced object here so a lost client finalize or PDF recovery call
 * cannot leave retained bytes outside the registry.
 *
 * A reference with no object is reported, not thrown. Failing the call meant a
 * single dangling reference cost the whole board's revision: the caller aborts,
 * the capture task retries to exhaustion, and the meeting's whiteboard history
 * is lost permanently over one asset. The registry invariant this function
 * exists to hold — no retained bytes outside the registry — is unaffected by a
 * key with no bytes behind it.
 */
export async function commitRevisionWhiteboardAssets(
  db: Database,
  env: Env,
  input: {
    whiteboardId: string;
    spaceId: string;
    r2Keys: string[];
    now?: Date;
  },
): Promise<RevisionAssetCommitResult> {
  const now = input.now ?? new Date();
  const ownKeys = input.r2Keys.filter(
    (r2Key) =>
      extractWhiteboardDocumentAssetIdentity(r2Key)?.whiteboardId === input.whiteboardId,
  );

  // Bounded concurrency: one sequential R2 HEAD (plus a D1 round-trip) per
  // asset would spend hundreds of serial subrequests on a board with a large
  // PDF import, against the Worker's wall-clock and subrequest budgets.
  const outcomes = await mapWithConcurrency(
    ownKeys,
    REVISION_ASSET_CONCURRENCY,
    async (r2Key) => {
      const existing = await db.query.whiteboardAssets.findFirst({
        where: { r2Key, whiteboardId: input.whiteboardId },
        columns: { id: true, status: true },
      });
      // A deleting row has already crossed the durable deletion boundary. Do
      // not add it to a new immutable manifest while maintenance may be
      // removing the object.
      if (existing?.status === "deleting") return { r2Key, committed: false };
      const object = await headR2Object(env, r2Key);
      if (!object) return { r2Key, committed: false };
      if (existing) {
        // The row keeps the object out of the cleanup queue's reach.
        if (existing.status === "pending") {
          await commitWhiteboardAsset(db, {
            id: existing.id,
            whiteboardId: input.whiteboardId,
            r2Key,
            size: object.size,
            now,
          });
        }
        return { r2Key, committed: true };
      }

      // A new row for an object with none, refused while the cleanup queue
      // deletes the object, and kept only if the object outlived the insert
      // (see r2KeyBeingDeletedSql).
      const id = generateId("WHITEBOARD_ASSET");
      const filename = r2Key.split("/").pop() ?? "whiteboard-asset";
      const nowSeconds = Math.floor(now.getTime() / 1000);
      const inserted = await withD1Retry(
        () => db.run(sql`
          insert into ${whiteboardAssets} (
            id, whiteboard_id, space_id, r2_key, filename, mime_type, size, status,
            uploaded_by_user_id, guest_admission_id, expires_at, committed_at, created_at
          )
          select
            ${id}, ${input.whiteboardId}, ${input.spaceId}, ${r2Key}, ${filename},
            ${object.httpMetadata?.contentType ?? "application/octet-stream"}, ${object.size}, 'committed',
            null, null, null, ${nowSeconds}, ${nowSeconds}
          where not ${r2KeyBeingDeletedSql(r2Key)}
          on conflict do nothing
        `),
        { idempotent: true },
      );
      if (getRunChanges(inserted) === 0) {
        // Another writer registered it first, or the queue is deleting it.
        const registered = await db.query.whiteboardAssets.findFirst({
          where: { r2Key, whiteboardId: input.whiteboardId, status: "committed" },
          columns: { id: true },
        });
        return { r2Key, committed: Boolean(registered) };
      }
      if (await headR2Object(env, r2Key)) return { r2Key, committed: true };
      await db.delete(whiteboardAssets).where(and(eq(whiteboardAssets.id, id), eq(whiteboardAssets.whiteboardId, input.whiteboardId)));
      return { r2Key, committed: false };
    },
  );

  return {
    committedKeys: outcomes.filter((o) => o.committed).map((o) => o.r2Key),
    missingKeys: outcomes.filter((o) => !o.committed).map((o) => o.r2Key),
  };
}
