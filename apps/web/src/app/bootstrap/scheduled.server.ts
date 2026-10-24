import "@tanstack/react-start/server-only";
import { createDb } from "@orbmeet/db";
import { settleAllOrThrow, settleSequentiallyOrThrow } from "@/lib/settle-all-or-throw";
import { cleanupFileOperations } from "@/modules/assets/server/file-maintenance";
import { cleanupQueuedR2Objects } from "@/modules/assets/server/r2-cleanup.server";
import { runPaddleSubscriptionReconciliation } from "@/modules/billing/server/reconciliation.server";
import { runAuthenticationMaintenance } from "@/modules/identity/server/maintenance.server";
import { sweepQuietMeetings } from "@/modules/meetings/server/runtime/sweep.server";
import { registerUnregisteredRecordings } from "@/modules/meetings/server/media/recordings.server";
import { runMeetingScheduleNotificationMaintenance } from "@/modules/scheduling/server/notifications.server";
import { resumeStrandedSpacePurges } from "@/workflows/space-deletion/cleanup.server";
import { cleanupWhiteboardAssetOperations } from "@/modules/whiteboards/server/asset-maintenance";
import { resumeStrandedAccountDeletions } from "@/workflows/account-deletion/pipeline.server";
import { cleanupProcessedWebhookReceipts } from "@/platform/http/webhooks/receipts";
import { checkMediaNodes } from "@/modules/meetings/server/room/media-placement.server";
import { checkWhiteboardNodes } from "@/modules/whiteboards/server/board-placement.server";
import { logError } from "@/lib/logger";
import { DAILY_CRON, MINUTELY_CRON } from "./cron-schedules";


type Task = { label: string; run: () => Promise<unknown> };

/**
 * Cleanup that follows Meetings and deletions across every domain. Work with
 * steps and retries of its own runs as jobs (platform/jobs), not here.
 */
function cleanupTasks(env: Env, now: Date): Task[] {
  const db = createDb(env.DB);
  return [
    { label: "whiteboard asset operations", run: () => cleanupWhiteboardAssetOperations(db, env, now) },
    { label: "file operations", run: () => cleanupFileOperations(db, env, now) },
    { label: "orphaned R2 objects", run: () => cleanupQueuedR2Objects(db, env.R2_BUCKET, now) },
  ];
}

/** Every-minute cleanup. One failing task does not skip the rest. */
function runCleanup(env: Env, now: Date) {
  return settleSequentiallyOrThrow("Cleanup failed", cleanupTasks(env, now));
}

function tasksFor(cron: string, env: Env, now: Date): Task[] {
  switch (cron) {
    case MINUTELY_CRON:
      return [
        { label: "media nodes", run: () => checkMediaNodes(createDb(env.DB), env, now) },
        { label: "whiteboard nodes", run: () => checkWhiteboardNodes(createDb(env.DB), env, now) },
        { label: "quiet meetings", run: () => sweepQuietMeetings(env, now) },
        { label: "cleanup", run: () => runCleanup(env, now) },
        {
          label: "meeting schedule notifications",
          run: () => runMeetingScheduleNotificationMaintenance(env, now),
        },
      ];
    case DAILY_CRON:
      return [
        {
          label: "authentication maintenance",
          // Expired sessions go first, so a gated account's abandoned recovery
          // session cannot outlive its usefulness while the sweep works around it.
          run: async () => ({
            ...(await runAuthenticationMaintenance(env, now)),
            restartedDeletions: await resumeStrandedAccountDeletions(createDb(env.DB), env, now),
          }),
        },
        {
          label: "stranded Space purges",
          run: () => resumeStrandedSpacePurges(createDb(env.DB), env, now),
        },
        {
          label: "Paddle subscription reconciliation",
          run: () => runPaddleSubscriptionReconciliation(env, now),
        },
        {
          label: "webhook receipt cleanup",
          run: () => cleanupProcessedWebhookReceipts(createDb(env.DB), now),
        },
        {
          label: "unregistered recordings",
          run: () => registerUnregisteredRecordings(createDb(env.DB), env.R2_BUCKET, now),
        },
      ];
    default:
      throw new Error(`Unsupported Cron Trigger: ${cron}`);
  }
}

/** Run every task for a Cron Trigger, reporting all failures together. */
export async function runScheduled(
  cron: string,
  env: Env,
  now: Date,
): Promise<void> {
  const tasks = tasksFor(cron, env, now).map(({ label, run }) => ({
    label,
    promise: Promise.resolve().then(run),
  }));
  await settleAllOrThrow("Scheduled maintenance completed with failures", tasks, {
    onError: (error, task) => logError(`[scheduled] ${task.label} failed:`, error),
  });
}
