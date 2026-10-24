import type { Database } from "@orbmeet/db";
import { internalWhiteboardPrefix, whiteboardPrefix } from "@/platform/storage/r2-keys";
import {
  createR2CleanupBudget,
  deleteR2Prefix,
  referencedWhiteboardAssetKeys,
} from "@/modules/assets/server/r2-cleanup.server";
import { generateId } from "@/lib/ids";
import { startJob, type Job, type JobStep, type JobStepConfig } from "@/platform/jobs/jobs";
import { toWhiteboardRoomId } from "@orbmeet/whiteboard-core/whiteboard-room-id";
import { runSyncCommand } from "./sync-commands.server";

/**
 * Removing a deleted Whiteboard: its room database on the sync node (the board
 * itself) and its R2 objects.
 *
 * Once a board's rows are gone, its objects can only be found by its prefixes,
 * so the purge must not be lost: a best-effort purge after the delete leaked
 * the whole board whenever R2 failed or an object's lease was contested, with
 * nothing left that would ever look again. The purge is a job instead, started
 * *before* the delete — a job started after it could fail to start, and the
 * delete would already have committed. Started first, the job may run before
 * the delete lands, or for a delete that never lands, so it purges only once it
 * has seen the board's row gone: until then it waits, and a board that is
 * still there when it stops waiting is kept, objects and all.
 */
export type PurgeWhiteboardJob = Extract<Job, { kind: "purgeWhiteboard" }>;

/**
 * When, after the purge starts, it looks for the board's row: the delete it
 * was started ahead of normally lands within a second, and a board still
 * there at the last look was not deleted.
 */
const DELETE_CHECK_SCHEDULE_MS = [0, 5_000, 30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000];
/** One look at the row: retried while D1 cannot answer, never read as an answer. */
const CHECK_STEP: JobStepConfig = {
  retries: { limit: 10, delay: 10_000, backoff: "exponential" },
  timeout: 60_000,
};
/** A prefix purge is retried for about a day; each attempt resumes from its saved cursor. */
const PURGE_STEP: JobStepConfig = {
  retries: { limit: 20, delay: 60_000, backoff: "exponential" },
  timeout: 10 * 60_000,
};

/**
 * Start the purge of `whiteboardId`'s objects, ahead of deleting its row. Each
 * call is its own purge, so deleting a board again after a failed attempt is
 * never answered by the earlier, finished job.
 */
export async function startWhiteboardPurge(
  env: Pick<Env, "JOBS">,
  whiteboardId: string,
): Promise<PurgeWhiteboardJob> {
  const job: PurgeWhiteboardJob = {
    kind: "purgeWhiteboard",
    purgeId: generateId("WHITEBOARD_PURGE"),
    whiteboardId,
    requestedAt: Date.now(),
  };
  await startJob(env, job);
  return job;
}

/**
 * Delete a board's room database on the sync node: the board itself. Every
 * deletion path calls this, since nothing else ever removes the file.
 * Idempotent.
 */
export async function purgeWhiteboardRoom(env: Env, whiteboardId: string): Promise<void> {
  // Every board's sync room id is its whiteboard id, so this works once the
  // row naming it is gone.
  await runSyncCommand(env, "purge", {
    whiteboardRoomId: toWhiteboardRoomId(whiteboardId),
    whiteboardId,
  });
}

export async function runWhiteboardPurge(
  step: JobStep,
  db: Database,
  env: Env,
  job: PurgeWhiteboardJob,
): Promise<"purged" | "kept"> {
  for (const [index, offset] of DELETE_CHECK_SCHEDULE_MS.entries()) {
    const look = index + 1;
    await step.sleepUntil(`wait for the delete, look ${look}`, job.requestedAt + offset);
    const exists = await step.do(`look for the board, look ${look}`, CHECK_STEP, async () =>
      Boolean(await db.query.whiteboards.findFirst({
        where: { id: job.whiteboardId },
        columns: { id: true },
      })));
    if (!exists) break;
    // The delete did not happen: the board, and so its objects, stay.
    if (look === DELETE_CHECK_SCHEDULE_MS.length) return "kept";
  }

  await step.do("delete the board's room", PURGE_STEP, async () => {
    await purgeWhiteboardRoom(env, job.whiteboardId);
    return null;
  });
  await step.do("purge the board's internal objects", PURGE_STEP, async () => {
    await deleteR2Prefix(db, env.R2_BUCKET, internalWhiteboardPrefix(job.whiteboardId), createR2CleanupBudget());
    return null;
  });
  await step.do("purge the board's objects", PURGE_STEP, async () => {
    await deleteR2Prefix(
      db,
      env.R2_BUCKET,
      whiteboardPrefix(job.whiteboardId),
      createR2CleanupBudget(),
      await referencedWhiteboardAssetKeys(db, job.whiteboardId),
    );
    return null;
  });
  return "purged";
}
