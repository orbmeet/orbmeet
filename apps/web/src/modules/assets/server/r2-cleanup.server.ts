import "@tanstack/react-start/server-only";
import type { Database } from "@orbmeet/db";
import {
  files,
  meetingArtifacts,
  meetingWhiteboards,
  r2ObjectCleanupTasks,
  whiteboardAssetReferences,
  whiteboardAssets,
  whiteboardRevisionAssetReferences,
  whiteboardRevisions,
} from "@orbmeet/db/schema";
import { internalMeetingPrefix, meetingPrefix } from "@/platform/storage/r2-keys";
import { and, asc, eq, inArray, isNull, lte, sql, type SQL } from "drizzle-orm";
import type { BatchStatement } from "@/platform/database/db-batching";
import { boundedStatements } from "@/platform/database/db-batching";
import { withD1Retry } from "@/platform/database/db-utils";
import { readMaintenanceCursor, writeMaintenanceCursor } from "@/platform/database/maintenance-cursor";

const DEFAULT_R2_CLEANUP_OPERATIONS = 16;
const R2_OBJECT_CLEANUP_BATCH_SIZE = 50;
const R2_PREFIX_DELETE_PAGE_SIZE = 1000;
const R2_OBJECT_CLEANUP_GRACE_MS = 10 * 60_000;
const R2_OBJECT_REFERENCED_RECHECK_BASE_MS = 24 * 60 * 60_000;
const R2_OBJECT_REFERENCED_RECHECK_JITTER_MS = 6 * 60 * 60_000;
const R2_OBJECT_CLEANUP_RETRY_BASE_MS = 60_000;
const R2_OBJECT_CLEANUP_RETRY_MAX_MS = 24 * 60 * 60_000;
export function r2CleanupRetryDelayMs(attempt: number): number {
  const exponent = Math.max(0, Math.min(attempt - 1, 20));
  return Math.min(R2_OBJECT_CLEANUP_RETRY_BASE_MS * 2 ** exponent, R2_OBJECT_CLEANUP_RETRY_MAX_MS);
}

export function r2ReferencedRecheckDelayMs(r2Key: string): number {
  // Stable jitter spreads long-lived referenced keys across the day so a large
  // cohort cannot repeatedly monopolize the head of the due queue.
  let hash = 0;
  for (const character of r2Key) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return R2_OBJECT_REFERENCED_RECHECK_BASE_MS + (hash % R2_OBJECT_REFERENCED_RECHECK_JITTER_MS);
}

/** How an object is owed to the cleanup queue. */
export interface R2ObjectDebt {
  /**
   * How long the row that will refer to the object may still take to be
   * written. Owing an object before its reference lands is safe only while
   * the queue cannot find it unreferenced in between, so the queue first
   * looks this long after its usual grace. Zero for an object that is
   * garbage already, or whose reference lands within the grace.
   */
  referenceWithinMs?: number;
}

/**
 * The statements that owe `r2Keys`' objects to the cleanup queue, for a caller
 * to run in the batch whose commit makes them garbage. The queue deletes each
 * object once nothing refers to it when it looks, so an object whose reference
 * is still to come is owed with `referenceWithinMs`.
 */
export function r2ObjectCleanupStatements(
  db: Database,
  r2Keys: readonly string[],
  now = new Date(),
  { referenceWithinMs = 0 }: R2ObjectDebt = {},
): BatchStatement[] {
  const notBefore = new Date(now.getTime() + R2_OBJECT_CLEANUP_GRACE_MS + referenceWithinMs);
  return [...new Set(r2Keys)].map((r2Key) =>
    db
      .insert(r2ObjectCleanupTasks)
      .values({ r2Key, notBefore, attempts: 0, lastError: null, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: r2ObjectCleanupTasks.r2Key,
        set: { notBefore, attempts: 0, lastError: null, updatedAt: now },
      }));
}

export async function enqueueR2ObjectCleanup(
  db: Database,
  r2Keys: readonly string[],
  now = new Date(),
  debt: R2ObjectDebt = {},
): Promise<void> {
  const statements = r2ObjectCleanupStatements(db, r2Keys, now, debt);
  for (let offset = 0; offset < statements.length; offset += R2_OBJECT_CLEANUP_BATCH_SIZE) {
    const [first, ...rest] = statements.slice(offset, offset + R2_OBJECT_CLEANUP_BATCH_SIZE);
    await withD1Retry(() => db.batch([first, ...rest]), { idempotent: true });
  }
}

/**
 * Take back an object owed to the cleanup queue, for the batch that commits
 * the row referring to it: written before the object, the debt covers every
 * way the commit can fail to happen, and this settles it when it does. It
 * takes the object back only if a row refers to it once the statements before
 * it have run, so a commit that changed nothing leaves the debt standing. A
 * key the queue has started deleting is left alone; the statement that adds
 * the reference must refuse it (`r2KeyBeingDeletedSql`).
 */
export function keepR2ObjectStatement(db: Database, r2Key: string) {
  return db
    .delete(r2ObjectCleanupTasks)
    .where(and(
      eq(r2ObjectCleanupTasks.r2Key, r2Key),
      isNull(r2ObjectCleanupTasks.deletingAt),
      sql`not (${unreferencedR2KeySql(r2Key)})`,
    ));
}

/**
 * Whether the cleanup queue is deleting `r2Key`'s object. A statement that
 * gives an existing object a new reference must refuse while this holds, and
 * check the object still exists once it has committed: a deletion is marked in
 * the same statement that finds the key unreferenced, so a reference either
 * lands first (and the key is kept) or is refused here.
 */
export function r2KeyBeingDeletedSql(r2Key: SQL | string): SQL {
  return sql`exists (
    select 1 from ${r2ObjectCleanupTasks}
    where ${r2ObjectCleanupTasks.r2Key} = ${r2Key}
      and ${r2ObjectCleanupTasks.deletingAt} is not null
  )`;
}

/**
 * No row of any kind refers to `r2Key`. A Meeting's capture slot refers to
 * its object only until the usage is captured: the revision then holds its
 * own copy, and the slot's key stays on the row only as a record that the
 * board was shared.
 */
function unreferencedR2KeySql(r2Key: string): SQL {
  return sql`not exists (select 1 from ${files} where ${files.r2Key} = ${r2Key})
    and not exists (select 1 from ${meetingArtifacts} where ${meetingArtifacts.r2Key} = ${r2Key})
    and not exists (select 1 from ${whiteboardAssets} where ${whiteboardAssets.r2Key} = ${r2Key})
    and not exists (select 1 from ${whiteboardAssetReferences} where ${whiteboardAssetReferences.r2Key} = ${r2Key})
    and not exists (
      select 1 from ${whiteboardRevisionAssetReferences}
      where ${whiteboardRevisionAssetReferences.r2Key} = ${r2Key}
    )
    and not exists (select 1 from ${whiteboardRevisions} where ${whiteboardRevisions.snapshotR2Key} = ${r2Key})
    and not exists (
      select 1 from ${meetingWhiteboards}
      where ${meetingWhiteboards.lastSharedSnapshotR2Key} = ${r2Key}
        and ${meetingWhiteboards.capturedRevisionId} is null
    )`;
}

/**
 * Delete the due keys no row references any more. Each is marked deleting by
 * the statement that finds it unreferenced — one decision, so no reference can
 * slip between the check and the mark — and only then is its object deleted
 * and its task removed. A marked key that crashed mid-deletion is finished by
 * the next pass.
 */
export async function cleanupQueuedR2Objects(
  db: Database,
  bucket: R2Bucket,
  now = new Date(),
): Promise<number> {
  const tasks = await db
    .select({
      r2Key: r2ObjectCleanupTasks.r2Key,
      attempts: r2ObjectCleanupTasks.attempts,
    })
    .from(r2ObjectCleanupTasks)
    .where(lte(r2ObjectCleanupTasks.notBefore, now))
    .orderBy(asc(r2ObjectCleanupTasks.notBefore), asc(r2ObjectCleanupTasks.r2Key))
    .limit(R2_OBJECT_CLEANUP_BATCH_SIZE);
  let cleaned = 0;
  for (const task of tasks) {
    try {
      const marked = await withD1Retry(
        () =>
          db
            .update(r2ObjectCleanupTasks)
            .set({ deletingAt: sql`coalesce(${r2ObjectCleanupTasks.deletingAt}, unixepoch())`, updatedAt: now })
            .where(and(eq(r2ObjectCleanupTasks.r2Key, task.r2Key), unreferencedR2KeySql(task.r2Key)))
            .returning({ r2Key: r2ObjectCleanupTasks.r2Key }),
        { idempotent: true },
      );
      if (marked.length > 0) {
        await bucket.delete(task.r2Key);
        cleaned += 1;
        await withD1Retry(
          () => db.delete(r2ObjectCleanupTasks).where(eq(r2ObjectCleanupTasks.r2Key, task.r2Key)),
          { idempotent: true },
        );
      } else {
        // References can disappear later through an FK cascade that does not
        // know the underlying object key. Preserve that safety net, but move
        // healthy objects far out of the hot queue and spread their rechecks.
        // A mark a purge left stays: that purge is deleting the object.
        await withD1Retry(
          () =>
            db
              .update(r2ObjectCleanupTasks)
              .set({
                notBefore: new Date(now.getTime() + r2ReferencedRecheckDelayMs(task.r2Key)),
                lastError: null,
                updatedAt: now,
              })
              .where(eq(r2ObjectCleanupTasks.r2Key, task.r2Key)),
          { idempotent: true },
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const nextAttempt = task.attempts + 1;
      await withD1Retry(
        () =>
          db
            .update(r2ObjectCleanupTasks)
            .set({
              attempts: nextAttempt,
              notBefore: new Date(now.getTime() + r2CleanupRetryDelayMs(nextAttempt)),
              lastError: message.slice(0, 1000),
              updatedAt: now,
            })
            .where(eq(r2ObjectCleanupTasks.r2Key, task.r2Key)),
        { idempotent: true },
      );
    }
  }
  return cleaned;
}

/**
 * Mark keys deleting outright, for a purge that has already decided their
 * owner is gone (see `r2KeyBeingDeletedSql`).
 */
async function markR2KeysDeleting(db: Database, r2Keys: readonly string[], now: Date): Promise<void> {
  const marks = boundedStatements(r2Keys, (chunk) =>
    db
      .insert(r2ObjectCleanupTasks)
      .values(chunk.map((r2Key) => ({
        r2Key,
        notBefore: now,
        attempts: 0,
        deletingAt: now,
        createdAt: now,
        updatedAt: now,
      })))
      .onConflictDoUpdate({ target: r2ObjectCleanupTasks.r2Key, set: { deletingAt: now, updatedAt: now } }));
  for (const mark of marks) await withD1Retry(() => mark, { idempotent: true });
}

async function forgetR2Keys(db: Database, r2Keys: readonly string[]): Promise<void> {
  const deletions = boundedStatements(r2Keys, (chunk) =>
    db.delete(r2ObjectCleanupTasks).where(inArray(r2ObjectCleanupTasks.r2Key, chunk)));
  for (const deletion of deletions) await withD1Retry(() => deletion, { idempotent: true });
}

export interface R2CleanupBudget {
  remainingOperations: number;
}

export function createR2CleanupBudget(operations = DEFAULT_R2_CLEANUP_OPERATIONS): R2CleanupBudget {
  return { remainingOperations: operations };
}

export function consumeR2CleanupOperation(budget: R2CleanupBudget): void {
  if (budget.remainingOperations <= 0) {
    throw new Error("R2 cleanup operation budget exhausted; retry cleanup in a new invocation");
  }
  budget.remainingOperations -= 1;
}

export async function deleteR2Prefix(
  db: Database,
  bucket: R2Bucket,
  prefix: string,
  budget = createR2CleanupBudget(),
  retainedKeys: ReadonlySet<string> = new Set(),
): Promise<void> {
  const cursorJob = `r2:${prefix}`;
  if (cursorJob.length > 100) {
    throw new Error(`R2 cleanup cursor key is too long for prefix: ${prefix}`);
  }
  let cursor = (await readMaintenanceCursor(db, cursorJob)) ?? undefined;
  while (true) {
    consumeR2CleanupOperation(budget);
    const listed = await bucket.list({
      prefix,
      limit: R2_PREFIX_DELETE_PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
    });
    const deletableKeys = listed.objects
      .map((object) => object.key)
      .filter((key) => !retainedKeys.has(key));
    if (deletableKeys.length > 0) {
      // Marked first, so nothing starts referencing a key while its object
      // goes; a crash leaves the marks for the cleanup queue to finish.
      await markR2KeysDeleting(db, deletableKeys, new Date());
      consumeR2CleanupOperation(budget);
      await bucket.delete(deletableKeys);
      await forgetR2Keys(db, deletableKeys);
    }
    if (!listed.truncated) {
      await writeMaintenanceCursor(db, cursorJob, null);
      return;
    }
    if (!listed.cursor) {
      throw new Error(`R2 returned a truncated page without a cursor for ${prefix}`);
    }
    cursor = listed.cursor;
    await writeMaintenanceCursor(db, cursorJob, cursor);
  }
}

/**
 * Delete every namespace a Meeting owns. Whiteboards are durable Space objects
 * and never belong to the occurrence, so their namespaces are intentionally
 * left alone.
 */
export async function deleteMeetingR2Namespaces(
  db: Database,
  bucket: R2Bucket,
  meetingId: string,
  whiteboardId: string | null,
  budget = createR2CleanupBudget(),
): Promise<void> {
  await deleteR2Prefix(db, bucket, meetingPrefix(meetingId), budget);
  await deleteR2Prefix(db, bucket, internalMeetingPrefix(meetingId), budget);
  void whiteboardId;
}

/**
 * A deleted whiteboard's assets that another board's copy still references:
 * what a purge of its prefix must keep.
 */
export async function referencedWhiteboardAssetKeys(db: Database, whiteboardId: string): Promise<Set<string>> {
  const retained = await db
    .select({ r2Key: whiteboardAssetReferences.r2Key })
    .from(whiteboardAssetReferences)
    .where(eq(whiteboardAssetReferences.sourceWhiteboardId, whiteboardId));
  return new Set(retained.map((asset) => asset.r2Key));
}
