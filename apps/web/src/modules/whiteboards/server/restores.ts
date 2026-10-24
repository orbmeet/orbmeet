/**
 * Restoring a Whiteboard to a revision.
 *
 * A restore spans two services: the sync server replaces the board and stores
 * the state it replaced as a restore point, and D1 records that restore point
 * in History. It runs as a durable job whose steps are those two halves, each
 * retried on its own, so an interruption anywhere — a timeout, a lost
 * response, a D1 error — resumes where it stopped.
 *
 * The sync server keeps each finished command's result by id and refuses to
 * start one after its `startBefore`, so asking again joins the first run and
 * never starts a restore late: it returns the first answer, or `expired` for
 * a restore that never ran. The request that asks for a restore waits for the
 * job's outcome for a while, and answers with it.
 */
import type { Database } from "@orbmeet/db";
import type { SyncCommandFailure } from "@orbmeet/whiteboard-core/sync-commands";
import { toWhiteboardRoomId } from "@orbmeet/whiteboard-core/whiteboard-room-id";
import { whiteboardRevisionKey } from "@orbmeet/whiteboard-core/document-keys";
import { AppError, Errors } from "@/lib/app-errors";
import { generateId } from "@/lib/ids";
import { logError, logWarn } from "@/lib/logger";
import { jobStepWindowMs, startJob, waitForJob, type Job, type JobStep, type JobStepConfig } from "@/platform/jobs/jobs";
import { recordRestorePointInHistory } from "./document-revisions";
import { enqueueR2ObjectCleanup } from "@/modules/assets/server/r2-cleanup.server";
import { runSerially } from "@/app/serial/serial";
import { expectSyncCommand, newCommandId, sendSyncCommand } from "./sync-commands.server";

/** How long the sync server may take to start a restore once it is asked. */
const START_WINDOW_MS = 2 * 60_000;
/** How long the asking request waits for the outcome. */
const WAIT_FOR_OUTCOME_MS = 20_000;

/** The sync server's half: retried until it answers, which it does by the start window's end. */
const RESTORE_STEP: Required<JobStepConfig> = {
  retries: { limit: 8, delay: 5_000, backoff: "exponential" },
  timeout: 2 * 60_000,
};
/** D1's half: a History entry is retried for a day and more before its restore point is dropped. */
const HISTORY_STEP: Required<JobStepConfig> = {
  retries: { limit: 12, delay: 30_000, backoff: "exponential" },
  timeout: 2 * 60_000,
};
/**
 * How long after the job owes its restore point to cleanup the History entry
 * that keeps it may still be recorded: both halves run to their last retry.
 */
const RESTORE_POINT_RECORDED_WITHIN_MS = jobStepWindowMs(RESTORE_STEP) + jobStepWindowMs(HISTORY_STEP);

type RestoreJob = Extract<Job, { kind: "restoreWhiteboard" }>;
type Board = { id: string; spaceId: string; syncRoomId: string };

/** What a restore job resolves: the undo entry it recorded, or the sync server's refusal. */
export type RestoreJobOutput =
  | { kind: "restored"; restorePointRevisionId: string | null }
  | { kind: "refused"; failure: Omit<SyncCommandFailure, "ok"> };

export interface RestoreOutcome {
  /** The History entry that undoes this restore, when there is one. */
  restorePointRevisionId: string | null;
}

export async function restoreWhiteboardFromRevision(
  db: Database,
  env: Env,
  input: { whiteboardId: string; revisionId: string; userId: string; now?: Date },
): Promise<RestoreOutcome> {
  const board = await db.query.whiteboards.findFirst({
    where: { id: input.whiteboardId, status: "active" },
    columns: { id: true },
  });
  if (!board) throw Errors.NOT_FOUND("Whiteboard");
  // Scoped by board, not by revision id alone: an id is otherwise a key to
  // any board's history, and reading one would be enough to paste it onto
  // your own.
  const revision = await db.query.whiteboardRevisions.findFirst({
    where: { id: input.revisionId, whiteboardId: board.id },
    columns: { snapshotR2Key: true },
  });
  if (!revision) throw Errors.NOT_FOUND("Snapshot");

  const now = input.now?.getTime() ?? Date.now();
  const job: RestoreJob = {
    kind: "restoreWhiteboard",
    restoreId: newCommandId(),
    whiteboardId: board.id,
    sourceR2Key: revision.snapshotR2Key,
    restorePointRevisionId: generateId("WHITEBOARD_REVISION"),
    userId: input.userId,
    // A deadline the sync server checks against its own clock, so it is set
    // from the real clock rather than the caller's `now`.
    startBefore: Date.now() + START_WINDOW_MS,
    requestedAt: now,
  };
  await startJob(env, job);
  const output = (await waitForJob(env, job, WAIT_FOR_OUTCOME_MS)) as RestoreJobOutput | undefined;
  if (!output) {
    throw new AppError(
      "WHITEBOARD_UNAVAILABLE",
      "The restore could not be confirmed. If it went through, it will appear in History shortly.",
      503,
    );
  }
  if (output.kind === "refused") {
    expectSyncCommand({ ok: false, ...output.failure });
    throw new Error("unreachable: a refused restore always fails");
  }
  return { restorePointRevisionId: output.restorePointRevisionId };
}

/** The restore job: replace the board, then record the state it replaced. */
export async function runWhiteboardRestore(
  step: JobStep,
  db: Database,
  env: Env,
  job: RestoreJob,
): Promise<RestoreJobOutput> {
  const board = await step.do("read board", async () => {
    const found = await db.query.whiteboards.findFirst({
      where: { id: job.whiteboardId },
      columns: { id: true, syncRoomId: true, spaceId: true },
    });
    return found ?? null;
  });
  if (!board) return { kind: "refused", failure: { reason: "not_found", message: "Whiteboard not found" } };

  // The restore point is owed to the cleanup queue before the sync server
  // writes it, and taken back by the History entry that records it: one no
  // entry ever records is garbage, whichever way the job ends. The queue
  // leaves it alone for as long as this job may still record it.
  await step.do("owe the restore point to cleanup", async () => {
    await enqueueR2ObjectCleanup(
      db,
      [whiteboardRevisionKey(board.id, job.restorePointRevisionId)],
      new Date(),
      { referenceWithinMs: RESTORE_POINT_RECORDED_WITHIN_MS },
    );
    return null;
  });

  const answer = await restoreOnSyncServer(() => step.do("restore on the sync server", RESTORE_STEP, () =>
    runSerially(env, { kind: "restoreWhiteboardContent", board, job })));

  // Whatever the answer, History is decided by what is stored: the restore
  // point exists exactly when some run of this restore replaced different
  // content. A run that found the board already showing the target stores
  // none, and a refused run may still have stored one before failing — a real
  // earlier state of the board, kept in History rather than thrown away.
  const recorded = await recordHistory(step, db, env, board, job);
  if (answer.ok) return { kind: "restored", restorePointRevisionId: recorded };
  if (recorded) {
    logWarn("[whiteboard-restore] Kept the restore point of a restore that did not finish", {
      whiteboardId: board.id,
      restoreId: job.restoreId,
    });
  }
  return { kind: "refused", failure: answer.failure };
}

/**
 * Ask the sync server to replace the board's content; runs in the board's
 * serial scope, with every other change to its lifecycle. Unanswered, it
 * throws for the step to retry, and the same command id joins the first run.
 */
export async function restoreWhiteboardContent(
  env: Env,
  { board, job }: { board: Board; job: RestoreJob },
): Promise<{ ok: true } | { ok: false; failure: Omit<SyncCommandFailure, "ok"> }> {
  const result = await sendSyncCommand(env, "restore", {
    whiteboardRoomId: toWhiteboardRoomId(board.syncRoomId),
    whiteboardId: board.id,
    commandId: job.restoreId,
    startBefore: job.startBefore,
    sourceKey: job.sourceR2Key,
    restorePointKey: whiteboardRevisionKey(board.id, job.restorePointRevisionId),
  });
  if (result.ok) return { ok: true };
  if (result.reason === "unavailable") throw new Error(`Sync server unavailable: ${result.message}`);
  const { ok: _ok, ...failure } = result;
  return { ok: false, failure };
}

/**
 * Record the restore point in History, reading it back from the sync server so
 * its asset keys (the revision's garbage-collection pins) come with it.
 * Resolves the History entry, or null when there is no restore point.
 */
/**
 * The sync server's answer, or `unavailable` once the step has run out of
 * retries: by then the start window has long closed, so no late run can begin.
 */
async function restoreOnSyncServer<T>(
  run: () => Promise<T>,
): Promise<T | { ok: false; failure: Omit<SyncCommandFailure, "ok"> }> {
  try {
    return await run();
  } catch (error) {
    return {
      ok: false,
      failure: { reason: "unavailable", message: error instanceof Error ? error.message : "Sync server unavailable" },
    };
  }
}

async function recordHistory(
  step: JobStep,
  db: Database,
  env: Env,
  board: Board,
  job: RestoreJob,
): Promise<string | null> {
  const key = whiteboardRevisionKey(board.id, job.restorePointRevisionId);
  try {
    return await step.do("record the restore point in history", HISTORY_STEP, async () => {
      const stored = await sendSyncCommand(env, "readSnapshot", { key });
      if (!stored.ok) {
        if (stored.reason === "unavailable") throw new Error(`Sync server unavailable: ${stored.message}`);
        return null;
      }
      await recordRestorePointInHistory(db, env, {
        board,
        revisionId: job.restorePointRevisionId,
        stored: stored.meta,
        userId: job.userId,
        now: new Date(job.requestedAt),
      });
      return job.restorePointRevisionId;
    });
  } catch (error) {
    // Out of attempts: the object has no History entry, so nothing can reach
    // it, and the cleanup queue it is owed to deletes it.
    logError("[whiteboard-restore] Giving up on a restore's History entry", { restoreId: job.restoreId }, error);
    return null;
  }
}
