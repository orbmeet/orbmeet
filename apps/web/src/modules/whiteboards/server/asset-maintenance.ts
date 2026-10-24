import "@tanstack/react-start/server-only";

import type { Database } from "@orbmeet/db";
import { whiteboardAssets } from "@orbmeet/db/schema";
import { and, asc, eq, lte } from "drizzle-orm";
import { mapWithConcurrency } from "@orbmeet/primitives";
import {
  completeWhiteboardAssetDeletion,
  isWhiteboardAssetReferencedByRevision,
  requestWhiteboardAssetDeletion,
} from "./assets";

const ASSET_DELETE_BATCH_SIZE = 40;
const ASSET_DELETE_CONCURRENCY = 6;

/**
 * Advance the durable D1 → R2 asset-deletion saga.
 *
 * Expired upload intents first become `deleting`; committed deletes enter the
 * same state from the API. Only after R2 confirms deletion is the registry row
 * removed. Any interruption leaves work visible to the next cron invocation.
 */
export async function cleanupWhiteboardAssetOperations(
  db: Database,
  env: Env,
  now = new Date(),
): Promise<void> {
  const expired = await db.query.whiteboardAssets.findMany({
    where: {
      status: "pending",
      expiresAt: { lte: now },
    },
    columns: { id: true, whiteboardId: true },
    orderBy: { expiresAt: "asc" },
    limit: ASSET_DELETE_BATCH_SIZE,
  });
  for (const asset of expired) {
    await requestWhiteboardAssetDeletion(db, {
      id: asset.id,
      whiteboardId: asset.whiteboardId,
      from: "pending",
      now,
    });
  }

  const deleting = await db
    .select({
      id: whiteboardAssets.id,
      whiteboardId: whiteboardAssets.whiteboardId,
      r2Key: whiteboardAssets.r2Key,
    })
    .from(whiteboardAssets)
    .where(and(
      eq(whiteboardAssets.status, "deleting"),
      lte(whiteboardAssets.expiresAt, now),
    ))
    .orderBy(asc(whiteboardAssets.expiresAt))
    .limit(ASSET_DELETE_BATCH_SIZE);

  // A row in `deleting` cannot gain a revision reference (the reference
  // trigger requires a committed asset), and its row keeps the cleanup queue
  // away from the object, so the object can go once no revision holds it.
  const outcomes = await mapWithConcurrency(
    deleting,
    ASSET_DELETE_CONCURRENCY,
    async (asset) => {
      try {
        const retained = await isWhiteboardAssetReferencedByRevision(db, {
          whiteboardId: asset.whiteboardId,
          r2Key: asset.r2Key,
        });
        if (retained) {
          // A revision won the race with an API deletion request. Restore the
          // registry row rather than leaving a permanently deleting asset.
          await db.update(whiteboardAssets)
            .set({ status: "committed", expiresAt: null })
            .where(and(
              eq(whiteboardAssets.id, asset.id),
              eq(whiteboardAssets.whiteboardId, asset.whiteboardId),
              eq(whiteboardAssets.status, "deleting"),
            ));
          return null;
        }
        await env.R2_BUCKET.delete(asset.r2Key);
        await completeWhiteboardAssetDeletion(db, asset);
        return null;
      } catch (error) {
        return error;
      }
    },
  );
  const failures = outcomes.filter((error) => error !== null);
  if (failures.length > 0) {
    throw new AggregateError(failures, "Whiteboard asset cleanup failed");
  }
}
