import type { Database } from "@orbmeet/db";
import { files, meetingArtifacts, whiteboardAssets } from "@orbmeet/db/schema";
import { eq } from "drizzle-orm";
import { readMaintenanceCursor, writeMaintenanceCursor } from "@/platform/database/maintenance-cursor";
import { logError, logWarn } from "@/lib/logger";
import {
  PROMOTION_INTENTS_PREFIX,
  finalKeyFromPromotionIntentMarker,
  promotionIntentMarkerKey,
} from "@/platform/storage/r2-keys";

/**
 * Durable reconciliation intent for promoted uploads.
 *
 * Promoting an immutable upload creates the permanent R2 object before the
 * metadata commit that accounts for it. A worker dying between the two would
 * otherwise strand a permanent object with no D1 row: lifecycle only expires
 * `staging/`, and every cleanup sweep discovers objects through rows, so
 * nothing could ever find it again. The compensating intent is a tiny marker
 * object whose key encodes the guarded final key. It is written BEFORE
 * promotion and retired after the commit succeeds; anything still holding a
 * marker once the grace period has passed is conclusively unresolved and gets
 * reconciled by {@link sweepUnregisteredPromotionIntents} — never by the
 * request path, which still never compensates a database error by deleting an
 * immutable final key.
 *
 * The marker lives under a lifecycle-expired prefix of its own, so even a sweep
 * that keeps failing cannot accumulate markers forever. Its key is the payload:
 * a listing resolves final keys without reading a single body.
 */

export { PROMOTION_INTENTS_PREFIX as PROMOTION_INTENT_PREFIX };

/**
 * How long an in-flight finalize may legitimately hold its marker. The request
 * path holds it for seconds (presign validation, one promote, one D1 batch),
 * so this is enormously conservative; it exists so the sweep can never race a
 * live finalizer into deleting an object that was about to be registered.
 */
export const PROMOTION_INTENT_GRACE_MS = 48 * 60 * 60_000;

// Bounded work per maintenance run. Markers only linger when resolution keeps
// failing, so the steady-state set is empty; a pathological backlog drains at
// this rate per run instead of one run paginating the whole prefix.
//
// The bound is on *resolutions*, not on keys listed. R2 lists lexicographically
// rather than by age, and a marker inside its grace period costs one local
// timestamp comparison to skip — so bounding keys listed would let a single
// 200-key page be spent entirely on young markers that need no work,
// permanently hiding the older ones behind them. Those are exactly the markers
// this sweep exists for, and the prefix lifecycle deletes them at seven days
// whether or not they were ever reached. Listing therefore walks on past
// skipped keys and only the resolutions are counted, with the cursor carried
// across runs so a backlog that does fill a run resumes where it stopped
// instead of restarting at the same page. Page count is bounded separately: a
// prefix full of young markers must not consume an entire maintenance tick just
// because none of them costs a resolution.
const PROMOTION_INTENT_SWEEP_BATCH_SIZE = 200;
const PROMOTION_INTENT_SWEEP_MAX_PAGES = 20;
const PROMOTION_INTENT_SWEEP_CURSOR_JOB = "promotion-intent-sweep";

/**
 * One guarded final-key class: the shape of key this module accepts, and the
 * single D1 lookup that answers "is this object registered?" completely. Each
 * namespace below is pinned to exactly one table by that table's r2_key CHECK
 * (spaces/{id}/uploads/ → files, whiteboards/{id}/assets/ → whiteboard_assets,
 * meetings/{id}/exports/whiteboard/{publishId}.pdf → meeting_artifacts), so a
 * row search on the pinned table cannot miss an existing registration — and a
 * key outside these shapes can never be promoted through a marker at all.
 */
const GUARDED_KEY_CLASSES = [
  {
    label: "space upload",
    pattern: /^spaces\/[A-Za-z0-9._-]+\/uploads\/[A-Za-z0-9._-]+$/,
    registrationProbe: (db: Database, finalKey: string) =>
      db.select({ id: files.id }).from(files).where(eq(files.r2Key, finalKey)).limit(1),
  },
  {
    label: "whiteboard asset",
    pattern: /^whiteboards\/[A-Za-z0-9._-]+\/assets\/[A-Za-z0-9._-]+$/,
    registrationProbe: (db: Database, finalKey: string) =>
      db
        .select({ id: whiteboardAssets.id })
        .from(whiteboardAssets)
        .where(eq(whiteboardAssets.r2Key, finalKey))
        .limit(1),
  },
  {
    label: "meeting whiteboard handout",
    pattern: /^meetings\/[A-Za-z0-9._-]+\/exports\/whiteboard\/[A-Za-z0-9._-]+\.pdf$/,
    registrationProbe: (db: Database, finalKey: string) =>
      db
        .select({ id: meetingArtifacts.id })
        .from(meetingArtifacts)
        .where(eq(meetingArtifacts.r2Key, finalKey))
        .limit(1),
  },
] as const;

function guardedKeyClass(finalKey: string) {
  return GUARDED_KEY_CLASSES.find((guarded) => guarded.pattern.test(finalKey));
}

export function promotionIntentKey(finalKey: string): string {
  if (!guardedKeyClass(finalKey)) {
    throw new Error(`promotion intent does not guard a known final-key class: ${finalKey}`);
  }
  return promotionIntentMarkerKey(finalKey);
}

export function finalKeyFromPromotionIntent(intentKey: string): string | null {
  return parseGuardedPromotionIntent(intentKey)?.finalKey ?? null;
}

function parseGuardedPromotionIntent(
  intentKey: string,
): { finalKey: string; keyClass: (typeof GUARDED_KEY_CLASSES)[number] } | null {
  const finalKey = finalKeyFromPromotionIntentMarker(intentKey);
  if (finalKey === null) return null;
  const keyClass = guardedKeyClass(finalKey);
  return keyClass ? { finalKey, keyClass } : null;
}

/** Persist the reconciliation intent. Must complete before any promotion. */
export async function writePromotionIntent(
  bucket: R2Bucket,
  input: { finalKey: string; context?: Record<string, string> },
): Promise<void> {
  // Diagnostic only — the marker key, not this body, is what the sweep reads.
  await bucket.put(promotionIntentKey(input.finalKey), JSON.stringify({
    finalKey: input.finalKey,
    ...input.context,
    writtenAt: new Date().toISOString(),
  }), {
    customMetadata: {
      promotionIntent: guardedKeyClass(input.finalKey)?.label ?? "unknown",
    },
  });
}

/**
 * Reap what is conclusively unregistered.
 *
 * For every marker older than the grace period: a guarded object with a `files`
 * row (any status — `deleting` and `pending` rows are live accountability the
 * ordinary file lifecycle owns) is retained and its stale marker retired; an
 * object with no row was promoted and never registered, so it is deleted, and
 * only then its marker. Deleting the marker first would be the one way to lose
 * an object's last trace, so the order is object, then marker — a crash in
 * between just replays the same resolution next run.
 */
export async function sweepUnregisteredPromotionIntents(
  db: Database,
  bucket: R2Bucket,
  now = new Date(),
): Promise<void> {
  const failures: unknown[] = [];
  let resolutions = 0;
  let cursor = (await readMaintenanceCursor(db, PROMOTION_INTENT_SWEEP_CURSOR_JOB)) ?? undefined;
  let pages = 0;

  while (
    resolutions < PROMOTION_INTENT_SWEEP_BATCH_SIZE &&
    pages < PROMOTION_INTENT_SWEEP_MAX_PAGES
  ) {
    // Never fetch more keys than the remaining resolution budget. That makes
    // every returned page atomic for cursor purposes: the sweep either handles
    // the whole page and advances, or never requests it. Persistent failures
    // therefore cannot pin every later marker behind the same partial page.
    const limit = PROMOTION_INTENT_SWEEP_BATCH_SIZE - resolutions;
    const listed = await bucket.list({
      prefix: PROMOTION_INTENTS_PREFIX,
      limit,
      ...(cursor ? { cursor } : {}),
    });
    pages += 1;
    for (const object of listed.objects) {
      if (now.getTime() - object.uploaded.getTime() < PROMOTION_INTENT_GRACE_MS) continue;
      resolutions += 1;
      try {
        const parsed = parseGuardedPromotionIntent(object.key);
        if (!parsed) {
          // Not a key this module wrote. It guards nothing we can name, so the
          // marker is garbage by construction; say so before discarding it.
          logWarn("[assets] Retiring a malformed promotion-intent marker", { key: object.key });
          await bucket.delete(object.key);
          continue;
        }
        const { finalKey, keyClass } = parsed;
        // The class dispatch pins each guarded namespace to exactly one table,
        // so this single lookup is the whole registration question — a row in
        // any status (deleting, pending) is live accountability the object's
        // ordinary lifecycle owns, not something this sweep may reap.
        const [registered] = await keyClass.registrationProbe(db, finalKey);
        const guarded = await bucket.head(finalKey);
        if (!guarded) {
          // Promotion never landed; the intent is spent.
          await bucket.delete(object.key);
          continue;
        }
        if (registered) {
          // The object is accounted for; the marker has done its job.
          await bucket.delete(object.key);
          continue;
        }
        logError(
          `Reaping a promoted upload that was never registered after its grace period: ${finalKey}`,
        );
        await bucket.delete(finalKey);
        await bucket.delete(object.key);
      } catch (error) {
        // One stuck marker must not stop the others; the failure propagates so
        // the maintenance run reports failed and the cron retries this marker.
        failures.push(error);
      }
    }
    if (!listed.truncated) {
      // The prefix is exhausted, so there is no position left to resume from:
      // the next run starts at the beginning, which is now the whole of it.
      cursor = undefined;
      break;
    }
    if (!listed.cursor) {
      throw new Error(
        `R2 returned a truncated page without a cursor for ${PROMOTION_INTENTS_PREFIX}`,
      );
    }
    cursor = listed.cursor;
  }

  // Written before the failure check, so a run that resolved part of a backlog
  // and then hit a stuck marker still advances instead of replaying the page.
  await writeMaintenanceCursor(db, PROMOTION_INTENT_SWEEP_CURSOR_JOB, cursor ?? null);
  if (failures.length > 0) {
    throw new AggregateError(failures, "Promotion-intent sweep failed");
  }
}
