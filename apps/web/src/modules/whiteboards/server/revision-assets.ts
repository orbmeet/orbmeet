import type { Database } from "@orbmeet/db";
import {
  whiteboardAssetReferences,
  whiteboardRevisionAssetReferences,
  whiteboardRevisions,
  whiteboards,
} from "@orbmeet/db/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { SnapshotMeta } from "@orbmeet/whiteboard-core/sync-commands";
import { extractWhiteboardDocumentAssetIdentity } from "@orbmeet/whiteboard-core/whiteboard-asset-key";
import { boundedStatements } from "@/platform/database/db-batching";
import { logError } from "@/lib/logger";
import { r2KeyBeingDeletedSql } from "@/modules/assets/server/r2-cleanup.server";
import { commitRevisionWhiteboardAssets } from "./assets";

export interface PreparedWhiteboardRevision {
  revisionId: string;
  snapshotR2Key: string;
  assetKeys: string[];
  values: Omit<typeof whiteboardRevisions.$inferInsert, "revisionNumber">;
}

/**
 * A snapshot may retain assets owned by this document or by a document it was
 * legitimately copied from. Never let snapshot bytes create that ownership:
 * foreign keys must already be authorized by a durable reference row.
 */
export async function filterAuthorizedWhiteboardAssetKeys(
  db: Database,
  whiteboardId: string,
  r2Keys: readonly string[],
): Promise<string[]> {
  const foreignKeys = r2Keys.filter((r2Key) => {
    const identity = extractWhiteboardDocumentAssetIdentity(r2Key);
    return identity && identity.whiteboardId !== whiteboardId;
  });
  const authorized = new Set<string>();
  const lookups = boundedStatements([...new Set(foreignKeys)], (keys) =>
    db
      .select({
        r2Key: whiteboardAssetReferences.r2Key,
        sourceWhiteboardId: whiteboardAssetReferences.sourceWhiteboardId,
      })
      .from(whiteboardAssetReferences)
      .where(
        and(
          eq(whiteboardAssetReferences.whiteboardId, whiteboardId),
          inArray(whiteboardAssetReferences.r2Key, keys),
        ),
      ));
  for (const lookup of lookups) {
    for (const row of await lookup) {
      if (
        extractWhiteboardDocumentAssetIdentity(row.r2Key)?.whiteboardId === row.sourceWhiteboardId
      ) {
        authorized.add(row.r2Key);
      }
    }
  }
  return r2Keys.filter((r2Key) => {
    const identity = extractWhiteboardDocumentAssetIdentity(r2Key);
    return identity !== null && (identity.whiteboardId === whiteboardId || authorized.has(r2Key));
  });
}

/**
 * Insert a board's asset reference rows, only while the board row exists, so
 * they can share a batch with the board's own guarded insert. Chunked under
 * D1's bound-parameter limit.
 */
export function insertAssetReferencesForBoard(
  db: Database,
  whiteboardId: string,
  rows: ReadonlyArray<typeof whiteboardAssetReferences.$inferInsert>,
) {
  return boundedStatements(rows, (chunk) => db.run(sql`
    insert into ${whiteboardAssetReferences} (id, whiteboard_id, source_whiteboard_id, r2_key, created_at)
    select column1, column2, column3, column4, column5
    from (values ${sql.join(
      chunk.map((row) => sql`(${row.id}, ${row.whiteboardId}, ${row.sourceWhiteboardId}, ${row.r2Key}, ${
        Math.floor((row.createdAt ?? new Date()).getTime() / 1000)
      })`),
      sql`, `,
    )})
    where exists (select 1 from ${whiteboards} where ${whiteboards.id} = ${whiteboardId})
      and not ${r2KeyBeingDeletedSql(sql`column4`)}
    on conflict do nothing
  `));
}

function nextWhiteboardRevisionNumber(whiteboardId: string) {
  return sql<number>`(
    SELECT COALESCE(MAX(existing.revision_number), 0) + 1
    FROM ${whiteboardRevisions} AS existing
    WHERE existing.whiteboard_id = ${whiteboardId}
  )`;
}

export function preparedRevisionSelectColumns(prepared: PreparedWhiteboardRevision) {
  const values = prepared.values;
  const createdAtSeconds = Math.floor((values.createdAt ?? new Date()).getTime() / 1000);
  return {
    id: sql<string>`${values.id}`.as("id"),
    whiteboardId: sql<string>`${values.whiteboardId}`.as("whiteboard_id"),
    spaceId: sql<string>`${values.spaceId}`.as("space_id"),
    revisionNumber: nextWhiteboardRevisionNumber(values.whiteboardId).as("revision_number"),
    kind: sql<typeof values.kind>`${values.kind}`.as("kind"),
    sourceMeetingId: sql<string | null>`${values.sourceMeetingId ?? null}`.as("source_meeting_id"),
    snapshotR2Key: sql<string>`${values.snapshotR2Key}`.as("snapshot_r2_key"),
    snapshotHash: sql<string | null>`${values.snapshotHash ?? null}`.as("snapshot_hash"),
    assetManifest: sql<string | null>`${values.assetManifest ?? null}`.as("asset_manifest"),
    documentClock: sql<number | null>`${values.documentClock ?? null}`.as("document_clock"),
    snapshotSize: sql<number>`${values.snapshotSize}`.as("snapshot_size"),
    createdByUserId: sql<string | null>`${values.createdByUserId ?? null}`.as(
      "created_by_user_id",
    ),
    createdAt: sql<number>`${createdAtSeconds}`.as("created_at"),
  };
}

export function insertPreparedRevisionAssetReferences(
  db: Database,
  prepared: PreparedWhiteboardRevision,
) {
  const createdAt = prepared.values.createdAt ?? new Date();
  return boundedStatements([...new Set(prepared.assetKeys)], (keys) =>
    db
      .insert(whiteboardRevisionAssetReferences)
      .values(keys.map((r2Key) => ({ revisionId: prepared.revisionId, r2Key, createdAt })))
      .onConflictDoNothing());
}

/**
 * Turn a snapshot the sync server has stored at a revision key into the rows
 * that record it: reconcile the assets it references, and build the revision
 * row the caller inserts.
 *
 * Deliberately stops short of the D1 write. Meeting capture commits its row in
 * the same batch as the `meeting_whiteboards` update it belongs to, and a
 * restore point commits alongside its history pruning — so callers own the
 * write and its rollback.
 */
export async function prepareStoredRevision(
  db: Database,
  env: Env,
  input: {
    revisionId: string;
    whiteboardId: string;
    spaceId: string;
    stored: SnapshotMeta;
    kind: "meeting_end" | "pre_restore";
    sourceMeetingId: string | null;
    createdByUserId: string | null;
    now: Date;
  },
): Promise<PreparedWhiteboardRevision> {
  const referencedAssetKeys = await filterAuthorizedWhiteboardAssetKeys(
    db,
    input.whiteboardId,
    input.stored.assetKeys,
  );
  const { committedKeys, missingKeys } = await commitRevisionWhiteboardAssets(db, env, {
    whiteboardId: input.whiteboardId,
    spaceId: input.spaceId,
    r2Keys: referencedAssetKeys,
    now: input.now,
  });
  if (missingKeys.length > 0) {
    // Capture proceeds without them. The manifest is the authorization list for
    // reading a revision's assets, so recording a key with no object behind it
    // would authorize a 404; dropping it keeps the manifest describing what is
    // actually retrievable.
    logError(
      `[whiteboard-capture] ${missingKeys.length} referenced asset object(s) missing for whiteboard ${input.whiteboardId}; capturing without them:`,
      missingKeys.slice(0, 10),
    );
  }
  // Inherited document keys are not owned by this document, so the
  // commit helper does not register them. Their existing reference authority
  // was checked above; carry it into both the read manifest and the revision's
  // durable GC pins.
  const retainedAssetKeys = [
    ...new Set([
      ...committedKeys,
      ...referencedAssetKeys.filter(
        (key) => extractWhiteboardDocumentAssetIdentity(key)?.whiteboardId !== input.whiteboardId,
      ),
    ]),
  ].sort();
  return {
    revisionId: input.revisionId,
    snapshotR2Key: input.stored.key,
    assetKeys: retainedAssetKeys,
    values: {
      id: input.revisionId,
      whiteboardId: input.whiteboardId,
      spaceId: input.spaceId,
      kind: input.kind,
      sourceMeetingId: input.sourceMeetingId,
      snapshotR2Key: input.stored.key,
      snapshotHash: input.stored.hash,
      assetManifest: JSON.stringify(retainedAssetKeys),
      documentClock: input.stored.documentClock,
      snapshotSize: input.stored.size,
      createdByUserId: input.createdByUserId,
      createdAt: input.now,
    },
  };
}
