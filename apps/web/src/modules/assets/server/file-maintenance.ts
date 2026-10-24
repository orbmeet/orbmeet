import "@tanstack/react-start/server-only";

import type { Database } from "@orbmeet/db";
import { files } from "@orbmeet/db/schema";
import { and, asc, eq, lte } from "drizzle-orm";
import { mapWithConcurrency } from "@orbmeet/primitives";
import { withD1Retry } from "@/platform/database/db-utils";
import { sweepUnregisteredPromotionIntents } from "./promotion-intent";

const FILE_DELETE_BATCH_SIZE = 40;
const FILE_DELETE_CONCURRENCY = 6;

/**
 * Advance durable File deletions from D1 intent to R2 and metadata removal, and
 * reconcile promotion intents left behind by finalizers that died between
 * promoting an object and committing its metadata.
 *
 * This is the single maintenance trigger for both: the post-meeting cron already
 * invokes it, and the promotion-intent sweep wants exactly that cadence.
 */
export async function cleanupFileOperations(
  db: Database,
  env: Env,
  now = new Date(),
): Promise<void> {
  const deleting = await db
    .select({
      id: files.id,
      r2Key: files.r2Key,
    })
    .from(files)
    .where(and(eq(files.status, "deleting"), lte(files.expiresAt, now)))
    .orderBy(asc(files.expiresAt), asc(files.id))
    .limit(FILE_DELETE_BATCH_SIZE);

  const outcomes = await mapWithConcurrency(
    deleting,
    FILE_DELETE_CONCURRENCY,
    async (file) => {
      try {
        await env.R2_BUCKET.delete(file.r2Key);
        await withD1Retry(
          () => db.delete(files).where(and(eq(files.id, file.id), eq(files.status, "deleting"))),
          { idempotent: true },
        );
        return null;
      } catch (error) {
        return error;
      }
    },
  );

  // Run the reconciliation sweep even when individual deletions above failed:
  // the two are independent, and this function reports every failure together.
  const sweepError = await sweepUnregisteredPromotionIntents(db, env.R2_BUCKET, now).then(
    () => null,
    (error: unknown) => error,
  );

  const failures = outcomes.filter((error) => error !== null);
  if (failures.length > 0 || sweepError !== null) {
    throw new AggregateError(
      [...failures, ...(sweepError ? [sweepError] : [])],
      "File cleanup failed",
    );
  }
}
