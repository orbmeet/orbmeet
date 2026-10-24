import type { Database } from "@orbmeet/db";
import { meetingWhiteboards } from "@orbmeet/db/schema";
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { isWhiteboardConfigured } from "@/modules/whiteboards/server/config.server";
import { startJob, type JobStep, type JobStepConfig } from "@/platform/jobs/jobs";
import { captureMeetingWhiteboardUsageRevision } from "@/modules/whiteboards/server/document-revisions";

/**
 * Each capture is retried for about a day and a half before it is recorded as
 * failed; a manager can then start it over.
 */
const CAPTURE_STEP: JobStepConfig = {
  retries: { limit: 12, delay: 30_000, backoff: "exponential" },
  timeout: 2 * 60_000,
};

const NOT_CONFIGURED_REASON = "Whiteboard capture is not configured";

/** Why a presented Whiteboard produced no Meeting-history revision. */
export const NOTHING_SHARED_CAPTURE_REASON = "Nothing was ever shared from this Whiteboard";

export type WhiteboardCaptureState = "none" | "capturing" | "captured" | "failed";

/**
 * What a Meeting's Whiteboard captures add up to, from the status of each
 * Whiteboard it presented.
 */
export function deriveWhiteboardCaptureState(input: {
  hasWhiteboardState: boolean;
  captureStatuses: ReadonlyArray<"live" | "capturing" | "captured" | "failed">;
}): WhiteboardCaptureState {
  const statuses = input.captureStatuses;
  if (!input.hasWhiteboardState && statuses.length === 0) return "none";
  if (statuses.some((status) => status === "live" || status === "capturing")) return "capturing";
  if (statuses.some((status) => status === "failed")) return "failed";
  return input.hasWhiteboardState ? "captured" : "none";
}

export function isWhiteboardCaptureConfigured(env: Env): boolean {
  return isWhiteboardConfigured(env);
}

/**
 * Pin a Meeting-history revision for every Whiteboard the ended Meeting left
 * `capturing`. Each Whiteboard is its own step: one that keeps failing is
 * recorded as failed without holding up the others.
 */
export async function captureMeetingWhiteboards(
  step: JobStep,
  db: Database,
  env: Env,
  meetingId: string,
  options: { reopenFailed?: boolean } = {},
): Promise<void> {
  if (options.reopenFailed) {
    // A retry reopens its captures itself: were the request that started it to
    // flip them, a job that then failed to start would leave them `capturing`
    // with nothing capturing them, and no longer `failed` for another retry.
    await step.do("reopen failed captures", async () => {
      await db
        .update(meetingWhiteboards)
        .set({ captureStatus: "capturing", captureFailureReason: null })
        .where(recoverableFailures(meetingId));
      return null;
    });
  }
  // The meeting's room starts this job once every pin its boundaries owed has
  // landed, so what each board shared is settled. A board that was presented
  // but never pinned — opened and closed without a stroke, or its pin given up
  // — has nothing to turn into history: a finished outcome, not a capture.
  await step.do("classify presented whiteboards", async () => {
    await db.batch([
      db
        .update(meetingWhiteboards)
        .set({ captureStatus: "capturing" })
        .where(and(
          eq(meetingWhiteboards.meetingId, meetingId),
          eq(meetingWhiteboards.captureStatus, "live"),
          isNotNull(meetingWhiteboards.lastSharedSnapshotR2Key),
        )),
      db
        .update(meetingWhiteboards)
        .set({ captureStatus: "failed", captureFailureReason: NOTHING_SHARED_CAPTURE_REASON })
        .where(and(
          eq(meetingWhiteboards.meetingId, meetingId),
          eq(meetingWhiteboards.captureStatus, "live"),
          isNull(meetingWhiteboards.lastSharedSnapshotR2Key),
        )),
    ]);
    return null;
  });
  const usageIds = await step.do("list whiteboards to capture", async () => {
    const rows = await db
      .select({ id: meetingWhiteboards.id })
      .from(meetingWhiteboards)
      .where(and(eq(meetingWhiteboards.meetingId, meetingId), eq(meetingWhiteboards.captureStatus, "capturing")));
    return rows.map((row) => row.id);
  });
  if (usageIds.length === 0) return;

  if (!isWhiteboardCaptureConfigured(env)) {
    await step.do("record capture unavailable", () => markCaptureFailed(db, usageIds, NOT_CONFIGURED_REASON));
    return;
  }

  for (const usageId of usageIds) {
    try {
      // Every source was pinned at its boundary; a capture never reads the
      // living document.
      await step.do(`capture ${usageId}`, CAPTURE_STEP, async () => {
        await captureMeetingWhiteboardUsageRevision(db, env, usageId, new Date());
        return null;
      });
    } catch (error) {
      await step.do(`record failed capture ${usageId}`, () =>
        markCaptureFailed(db, [usageId], summarizeError(error)));
    }
  }
}

/** Whether every Whiteboard the Meeting presented has been captured or given up on. */
export async function whiteboardCapturesSettled(db: Database, meetingId: string): Promise<boolean> {
  const unsettled = await db.query.meetingWhiteboards.findFirst({
    where: { meetingId, captureStatus: { in: ["live", "capturing"] } },
    columns: { id: true },
  });
  return !unsettled;
}

/**
 * Start the failed captures of an ended Meeting over. Resolves false when
 * there is nothing a new attempt could capture.
 */
export async function retryFailedWhiteboardCaptures(db: Database, env: Env, meetingId: string): Promise<boolean> {
  const failed = await db
    .select({ id: meetingWhiteboards.id })
    .from(meetingWhiteboards)
    .where(recoverableFailures(meetingId))
    .limit(1);
  if (failed.length === 0) return false;
  await startJob(env, { kind: "captureMeetingWhiteboards", meetingId, attempt: Date.now() });
  return true;
}

/** Failed captures a new attempt could still make: their boundary state was pinned. */
function recoverableFailures(meetingId: string) {
  return and(
    eq(meetingWhiteboards.meetingId, meetingId),
    eq(meetingWhiteboards.captureStatus, "failed"),
    isNotNull(meetingWhiteboards.lastSharedSnapshotR2Key),
  );
}

async function markCaptureFailed(db: Database, usageIds: string[], reason: string): Promise<null> {
  await db
    .update(meetingWhiteboards)
    .set({ captureStatus: "failed", captureFailureReason: reason })
    .where(and(inArray(meetingWhiteboards.id, usageIds), eq(meetingWhiteboards.captureStatus, "capturing")));
  return null;
}

function summarizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 500) || "Whiteboard capture failed";
}
