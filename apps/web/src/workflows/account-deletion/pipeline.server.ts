import "@tanstack/react-start/server-only";

import type { Database } from "@orbmeet/db";
import { meetingLinks, meetings, spaces, users } from "@orbmeet/db/schema";
import { and, asc, eq, inArray, isNotNull, isNull, lte } from "drizzle-orm";
import { boundedStatements } from "@/platform/database/db-batching";
import { withD1Retry } from "@/platform/database/db-utils";
import { logError, logInfo } from "@/lib/logger";
import { cancelAccountSubscriptionBeforeDeletion } from "@/modules/billing/server/account-deletion-subscription.server";
import { revokeAccountAuthenticationExceptCurrent } from "@/modules/identity/server/account-deletion-auth.server";
import { findPersonalSpaceId } from "@/modules/spaces/server/personal";
import { callCoordinator } from "@/modules/meetings/server/runtime/client.server";
import { revokeFromOpenMeetings } from "@/modules/meetings/server/runtime/revoke.server";
import { cleanupAccountR2Objects } from "@/modules/identity/server/account-deletion.server";
import { startJob, type Job, type JobStep } from "@/platform/jobs/jobs";

/**
 * A deletion job normally finishes within seconds of its gate closing. One
 * whose gate closed longer ago than this and whose account still exists has a
 * job that failed for good, or never started (the Workflow was unreachable),
 * and the daily sweep starts it again.
 */
const STRANDED_DELETION_GRACE_MS = 60 * 60_000;
const STRANDED_DELETION_BATCH_LIMIT = 10;


type AccountDeletion = Extract<Job, { kind: "deleteAccount" }>;

/**
 * Erase an account whose deletion gate (`users.deletion_started_at`) is
 * closed: Paddle cancel → auth revocation → meeting eviction → archival →
 * erasure, each a Workflow step retried on its own.
 *
 * Every step is idempotent, so a retry, a restart or a second start repeats
 * nothing harmful:
 * - the Paddle preflight reads remote state and skips cancelled subscriptions;
 * - revocation, eviction and archival UPDATE/DELETE by predicate;
 * - erasure deletes by id and tolerates a missing row.
 * The gate is never cleared — clearing it would reopen the ownership races it
 * closed — and the user row going away is what marks the deletion complete.
 */
export async function deleteAccount(
  step: JobStep,
  db: Database,
  env: Env,
  job: AccountDeletion,
): Promise<void> {
  const { userId, exceptSessionId } = job;
  const deletionStartedAt = new Date(job.deletionStartedAt);

  // This must precede every destructive local step. The subscription ID and
  // customer ID are the only in-product handles for stopping future Paddle
  // renewals; once the user row is gone, webhook reconciliation cannot find
  // the customer and the user can no longer open the billing portal.
  await step.do("cancel billing", () => cancelAccountSubscriptionBeforeDeletion(db, env, userId));

  await step.do("revoke authentication", () =>
    revokeAccountAuthenticationExceptCurrent(db, userId, exceptSessionId));

  // Revoke every active meeting lineage before the user row cascades it away.
  await step.do("leave open meetings", () => revokeFromOpenMeetings(db, env, userId, "account_deleted"));

  const { personalSpaceId, meetingLinkIds } = await step.do("archive links", async () => {
    // Close the creation gate before enumerating occurrences. The occurrence
    // INSERT re-checks archivedAt in the same statement, so no join that raced
    // this update can create an untracked LiveKit room after the cleanup scan.
    // The personal space is the account's erasure boundary: its links,
    // meetings, whiteboards, and files are removed with the account. An
    // account that never created anything has none.
    const personalSpaceId = await findPersonalSpaceId(db, userId);
    if (personalSpaceId) {
      await withD1Retry(
        () =>
          db
            .update(meetingLinks)
            .set({ archivedAt: deletionStartedAt, updatedAt: deletionStartedAt })
            .where(and(eq(meetingLinks.spaceId, personalSpaceId), isNull(meetingLinks.archivedAt))),
        { idempotent: true },
      );
    }

    // A scheduled Space link is Space-owned rather than user-owned. Archive
    // schedules organized by this account before its user row cascades away,
    // otherwise the surviving one-time Space link would lose its time gate and
    // become an unscheduled startable room.
    const organizedSchedules = await db.query.meetingSchedules.findMany({
      where: { organizerUserId: userId },
      columns: { meetingLinkId: true },
    });
    const archivals = boundedStatements(organizedSchedules.map((item) => item.meetingLinkId), (ids) =>
      db
        .update(meetingLinks)
        .set({ archivedAt: deletionStartedAt, updatedAt: deletionStartedAt })
        .where(and(
          inArray(meetingLinks.id, ids),
          eq(meetingLinks.reusePolicy, "one_time"),
          isNull(meetingLinks.archivedAt),
        )));
    for (const archival of archivals) await withD1Retry(() => archival, { idempotent: true });

    // Links in the personal space are removed with their meeting data; links
    // in shared spaces are Space-owned and survive the account.
    const links = personalSpaceId
      ? await db.query.meetingLinks.findMany({ where: { spaceId: personalSpaceId }, columns: { id: true } })
      : [];
    return { personalSpaceId, meetingLinkIds: links.map((link) => link.id) };
  });

  if (meetingLinkIds.length > 0) {
    await step.do("end open meetings", async () => {
      // Defensive: the endpoint refuses while the account hosts an open
      // meeting, but one may have opened in the interim.
      const openMeetings: { id: string }[] = [];
      for (const lookup of boundedStatements(meetingLinkIds, (ids) =>
        db
          .select({ id: meetings.id })
          .from(meetings)
          .where(and(inArray(meetings.meetingLinkId, ids), eq(meetings.status, "open"))))) {
        openMeetings.push(...await lookup);
      }

      // Each coordinator ends its meeting and tears down its room. It keeps
      // working after the rows below are deleted: finishing an end is a no-op
      // on a missing row, and a recording that lands late fails the quota
      // insert and is deleted from R2.
      await Promise.all(openMeetings.map((meeting) =>
        callCoordinator(env, {
          kind: "command",
          meetingId: meeting.id,
          command: { kind: "end", subject: { kind: "system" }, reason: "system" },
        }).catch((error: unknown) => {
          logError("[account-deletion] Could not end a meeting", { meetingId: meeting.id, userId }, error);
        }),
      ));
    });
  }

  await step.do("release stored files", async () => {
    const delayedCleanupScope = await cleanupAccountR2Objects(db, env, userId, {
      meetingLinkIds,
      personalSpaceId,
    });
    await startJob(env, {
      kind: "accountCleanup",
      userId,
      personalSpaceId,
      ...delayedCleanupScope,
      requestedAt: deletionStartedAt.getTime(),
    });
  });

  await step.do("erase", async () => {
    for (const deletion of boundedStatements(meetingLinkIds, (ids) =>
      db.delete(meetingLinks).where(inArray(meetingLinks.id, ids)))) {
      await withD1Retry(() => deletion, { idempotent: true });
    }

    // Delete the personal space last among content: remaining personal rows
    // (schedules, empty links, whiteboard shells) cascade with it, and the
    // ownerUserId restrict FK would otherwise block the user delete.
    if (personalSpaceId) {
      await withD1Retry(
        () =>
          db
            .delete(spaces)
            .where(and(eq(spaces.id, personalSpaceId), eq(spaces.kind, "personal"), eq(spaces.ownerUserId, userId))),
        { idempotent: true },
      );
    }

    // Space meeting host snapshots and user-authored shared data use set-null
    // FKs, so shared history remains intact.
    await withD1Retry(() => db.delete(users).where(eq(users.id, userId)), { idempotent: true });
  });

  logInfo("[auth] Account deletion completed", { userId });
}

/**
 * Start again the deletions whose job failed for good or never started: every
 * account still behind its gate past the grace period. Starting is idempotent
 * (the job id names the account), so a deletion still running is left alone.
 * Returns how many were started or restarted.
 */
export async function resumeStrandedAccountDeletions(
  db: Database,
  env: Pick<Env, "JOBS">,
  now = new Date(),
): Promise<number> {
  const graceCutoff = new Date(now.getTime() - STRANDED_DELETION_GRACE_MS);
  const stranded = await db
    .select({ id: users.id, deletionStartedAt: users.deletionStartedAt })
    .from(users)
    .where(and(isNotNull(users.deletionStartedAt), lte(users.deletionStartedAt, graceCutoff)))
    .orderBy(asc(users.deletionStartedAt))
    .limit(STRANDED_DELETION_BATCH_LIMIT);

  for (const account of stranded) {
    await startJob(env, {
      kind: "deleteAccount",
      userId: account.id,
      deletionStartedAt: account.deletionStartedAt!.getTime(),
      exceptSessionId: null,
    }, { restartFailed: true });
    logInfo("[auth] Restarted a stranded account deletion", { userId: account.id });
  }
  return stranded.length;
}
