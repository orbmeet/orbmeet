import "@tanstack/react-start/server-only";

import { meetings, organizations, spaceMembers, spaces, users } from "@orbmeet/db/schema";
import { and, eq, isNull, sql } from "drizzle-orm";
import type * as v from "valibot";
import type { AuthFnContext } from "@/app/bootstrap/middleware";
import { Errors } from "@/lib/app-errors";
import { logInfo } from "@/lib/logger";
import type { deleteAccountSchema } from "@/modules/identity/contract/auth/schemas";
import { authorizeSensitiveAction } from "@/modules/identity/server/step-up.server";
import { anotherSpaceManagerRemainsSql } from "@/modules/spaces/server/helpers";
import { appendCookies, createCookieString } from "@/platform/http/cookies.server";
import { getRunChanges, withD1Retry } from "@/platform/database/db-utils";
import { enforceIpRateLimit, enforceRateLimit } from "@/platform/http/rate-limit.server";
import { startJob, waitForJob } from "@/platform/jobs/jobs";

/** How long the request waits for the deletion job before answering. */
const DELETION_WAIT_MS = 20_000;

export async function deleteAccountImpl({
  data,
  context: { user: currentUser, authSessionId, env, db },
}: {
  data: v.InferOutput<typeof deleteAccountSchema>;
  context: AuthFnContext;
}) {
  await enforceIpRateLimit(env, "delete-account");
  await enforceRateLimit(env, `account:delete:${currentUser.id}`);

  const accountState = await db.query.users.findFirst({
    where: { id: currentUser.id },
    columns: { deletionStartedAt: true },
  });
  if (!accountState) throw Errors.UNAUTHORIZED();
  const resumedDeletionStartedAt = accountState.deletionStartedAt;

  // Check for owned shared spaces (onDelete: "restrict"). Includes archived
  // spaces on purpose: their row (and this ownerUserId FK) survives until
  // cleanup hard-deletes it, so the DB would reject the user delete below
  // regardless. Blocking here turns that raw FK failure into a clear
  // message; the archived space clears once the maintenance rotation
  // finishes its cleanup. The personal space is deleted by this flow.
  const ownedSpaces = await db.query.spaces.findMany({
    where: { ownerUserId: currentUser.id, kind: "shared" },
    columns: { id: true, name: true, archivedAt: true },
    limit: 5,
  });

  if (ownedSpaces.length > 0) {
    // A space the user already deleted lingers (archived) until the maintenance
    // rotation finishes cleaning it up. Distinguish that transient state from a
    // space they still need to act on, so the message isn't confusing.
    const allArchived = ownedSpaces.every((space) => space.archivedAt !== null);
    throw Errors.VALIDATION(
      allArchived
        ? "A space you deleted is still being cleaned up. Please try again in a few minutes."
        : `You own ${ownedSpaces.length} space(s). Please delete or transfer ownership before deleting your account.`,
    );
  }

  const ownedOrganization = await db.query.organizations.findFirst({
    where: { ownerId: currentUser.id },
    columns: { id: true, name: true },
  });
  if (ownedOrganization) {
    throw Errors.VALIDATION(
      `Transfer ownership of “${ownedOrganization.name}” before deleting your account.`,
    );
  }

  const lastAdminSpace = await db
    .select({ id: spaces.id, name: spaces.name })
    .from(spaceMembers)
    .innerJoin(spaces, eq(spaces.id, spaceMembers.spaceId))
    .where(
      and(
        eq(spaceMembers.userId, currentUser.id),
        eq(spaceMembers.role, "admin"),
        sql`${spaces.organizationId} is not null`,
        sql`not ${anotherSpaceManagerRemainsSql(spaces.id, currentUser.id)}`,
      ),
    )
    .limit(1);
  if (lastAdminSpace.length > 0) {
    throw Errors.VALIDATION(
      `Assign another admin for “${lastAdminSpace[0].name}” before deleting your account.`,
    );
  }

  // Check for active hosted meetings (onDelete: "restrict")
  const activeMeetings = await db.query.meetings.findMany({
    where: { RAW: (row) => and(eq(row.startedByUserId, currentUser.id), eq(row.status, "open"))! },
    columns: { id: true },
    limit: 5,
  });

  if (activeMeetings.length > 0) {
    throw Errors.VALIDATION(
      `You have ${activeMeetings.length} active meeting(s). Please end all meetings before deleting your account.`,
    );
  }

  // The first attempt consumes an action-specific, browser-bound credential.
  // A retry already crossed that durable authorization boundary and can be
  // reached only through the one retained deletion-continuation session.
  // (The recovery page resumes without a credential — the resumed session
  // itself is the authorization — and `authorizeSensitiveAction` still
  // rejects a missing credential on a first attempt.)
  if (!resumedDeletionStartedAt) {
    await authorizeSensitiveAction(db, env, {
      credential: data.credential,
      userId: currentUser.id,
      authSessionId,
      action: "account_delete",
    });
  }

  // Atomically close every path that can create a new restrict-FK before
  // any irreversible work begins. Ownership writers check this marker in
  // the same statement that assigns ownership, so either their write wins
  // and this update declines, or this gate wins and later writers decline.
  let deletionStartedAt = resumedDeletionStartedAt ?? new Date();
  if (!resumedDeletionStartedAt) {
    const gateResult = await withD1Retry(
      () =>
        db
          .update(users)
          .set({
            deletionStartedAt,
            updatedAt: deletionStartedAt,
          })
          .where(
            and(
              eq(users.id, currentUser.id),
              isNull(users.deletionStartedAt),
              sql`not exists (
            select 1 from ${spaces} owned_space
            where owned_space.owner_user_id = ${currentUser.id}
              and owned_space.kind = 'shared'
          )`,
              sql`not exists (
            select 1 from ${organizations} owned_organization
            where owned_organization.owner_id = ${currentUser.id}
          )`,
              sql`not exists (
            select 1 from ${meetings} hosted_meeting
            where hosted_meeting.started_by_user_id = ${currentUser.id}
              and hosted_meeting.status = 'open'
          )`,
              sql`not exists (
            select 1
            from ${spaceMembers} deleting_admin
            inner join ${spaces} funded_space on funded_space.id = deleting_admin.space_id
            where deleting_admin.user_id = ${currentUser.id}
              and deleting_admin.role = 'admin'
              and funded_space.organization_id is not null
              and not ${anotherSpaceManagerRemainsSql(sql`funded_space.id`, currentUser.id)}
          )`,
            ),
          ),
      { idempotent: true },
    );
    if (getRunChanges(gateResult) === 0) {
      const existingGate = await db.query.users.findFirst({
        where: { id: currentUser.id },
        columns: { deletionStartedAt: true },
      });
      if (!existingGate?.deletionStartedAt) {
        throw Errors.CONFLICT(
          "Account ownership or Meeting state changed while deletion started. Please retry.",
        );
      }
      // A concurrent/prior attempt crossed the gate. Keep its durable marker
      // so every retry uses the same archival and cleanup timestamp.
      deletionStartedAt = existingGate.deletionStartedAt;
    }
  }

  // Everything after the gate is the deletion job (see pipeline.server.ts):
  // durable, each step retried on its own. A retry of this endpoint after the
  // job failed for good starts it again. The response waits for the job while
  // it is quick; one that is still running finishes on its own, and the
  // account is already closed behind its gate.
  const job = {
    kind: "deleteAccount" as const,
    userId: currentUser.id,
    deletionStartedAt: deletionStartedAt.getTime(),
    exceptSessionId: authSessionId,
  };
  await startJob(env, job, { restartFailed: true });
  await waitForJob(env, job, DELETION_WAIT_MS);

  logInfo("[auth] Account deletion requested", { userId: currentUser.id });

  // Clear both authentication and remembered-identity cookies.
  appendCookies([
    createCookieString("session", "", 0, {
      appUrl: env.APP_URL,
      environment: env.ENVIRONMENT,
    }),
    createCookieString("device", "", 0, {
      appUrl: env.APP_URL,
      environment: env.ENVIRONMENT,
    }),
  ]);

  return { success: true };
}
