/**
 * Moving an Organization to a new owner: a nomination the recipient accepts
 * or declines, with seat billing moved by the billing module.
 */

import { organizationOwnershipTransfers } from "@orbmeet/db/schema";
import { and, eq, gt } from "drizzle-orm";
import {
  getOrganizationSchema,
  transferOrganizationOwnershipSchema,
} from "@/modules/organizations/contract/schemas";
import { Errors } from "@/lib/app-errors";
import { hasSubscriptionEntitlements } from "@/modules/billing/contract/subscription";
import { withD1Retry } from "@/platform/database/db-utils";
import { enforceRateLimit } from "@/platform/http/rate-limit.server";
import type * as v from "valibot";
import type { AuthFnContext } from "@/app/bootstrap/middleware";
import { runSerially } from "@/app/serial/serial";
import { assertOrganizationRole, findOrganizationMembership } from "./authority.server";

const ORGANIZATION_TRANSFER_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export async function transferOrganizationOwnershipImpl({
  data,
  context: { user, env, db },
}: {
  data: v.InferOutput<typeof transferOrganizationOwnershipSchema>;
  context: AuthFnContext;
}) {
  await enforceRateLimit(env, `organization:transfer:${user.id}`);
  if (data.newOwnerUserId === user.id) {
    throw Errors.VALIDATION("You already own this organization.");
  }
  await assertOrganizationRole(db, data.organizationId, user.id, "owner");

  const [newOwner, membership, otherOrganization] = await Promise.all([
    db.query.users.findFirst({
      where: { id: data.newOwnerUserId },
      columns: {
        plan: true,
        paddleCustomerId: true,
        paddleSubscriptionId: true,
        subscriptionStatus: true,
        deletionStartedAt: true,
      },
    }),
    findOrganizationMembership(db, data.organizationId, data.newOwnerUserId),
    db.query.organizations.findFirst({
      where: { ownerId: data.newOwnerUserId },
      columns: { id: true },
    }),
  ]);
  if (
    !newOwner ||
    newOwner.deletionStartedAt !== null ||
    newOwner.plan !== "organization" ||
    !hasSubscriptionEntitlements(newOwner.subscriptionStatus) ||
    !newOwner.paddleCustomerId ||
    !newOwner.paddleSubscriptionId ||
    !membership ||
    otherOrganization
  ) {
    throw Errors.VALIDATION(
      "Choose a licensed Organization user who has an active Organization plan and does not own another Organization.",
    );
  }

  const now = new Date();
  await withD1Retry(
    () =>
      db
        .insert(organizationOwnershipTransfers)
        .values({
          organizationId: data.organizationId,
          requestedByUserId: user.id,
          proposedOwnerUserId: data.newOwnerUserId,
          expiresAt: new Date(now.getTime() + ORGANIZATION_TRANSFER_TTL_MS),
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: organizationOwnershipTransfers.organizationId,
          set: {
            requestedByUserId: user.id,
            proposedOwnerUserId: data.newOwnerUserId,
            expiresAt: new Date(now.getTime() + ORGANIZATION_TRANSFER_TTL_MS),
            createdAt: now,
            updatedAt: now,
          },
        }),
    { idempotent: true },
  );
  return { success: true, pendingAcceptance: true };
}

export async function acceptOrganizationOwnershipTransferImpl({
  data,
  context: { user, env, db },
}: {
  data: v.InferOutput<typeof getOrganizationSchema>;
  context: AuthFnContext;
}) {
  await enforceRateLimit(env, `organization:accept-transfer:${user.id}`);
  const now = new Date();
  const pending = await db.query.organizationOwnershipTransfers.findFirst({
    where: {
      RAW: (transfer) =>
        and(
          eq(transfer.organizationId, data.organizationId),
          eq(transfer.proposedOwnerUserId, user.id),
          gt(transfer.expiresAt, now),
        )!,
    },
    columns: { requestedByUserId: true },
  });
  if (!pending) {
    throw Errors.VALIDATION("This ownership transfer is no longer available.");
  }

  const transferred = await runSerially(env, {
    kind: "transferOrganizationOwnership",
    organizationId: data.organizationId,
    currentOwnerUserId: pending.requestedByUserId,
    newOwnerUserId: user.id,
    acceptedAt: now.getTime(),
  }, { callerWaits: true });
  if (!transferred) {
    throw Errors.VALIDATION(
      "Ownership could not be transferred. Confirm both subscriptions are active and try again.",
    );
  }

  await withD1Retry(
    () =>
      db
        .delete(organizationOwnershipTransfers)
        .where(
          and(
            eq(organizationOwnershipTransfers.organizationId, data.organizationId),
            eq(organizationOwnershipTransfers.proposedOwnerUserId, user.id),
          ),
        ),
    { idempotent: true },
  );
  return { success: true };
}

export async function declineOrganizationOwnershipTransferImpl({
  data,
  context: { user, env, db },
}: {
  data: v.InferOutput<typeof getOrganizationSchema>;
  context: AuthFnContext;
}) {
  await enforceRateLimit(env, `organization:decline-transfer:${user.id}`);
  await withD1Retry(
    () =>
      db
        .delete(organizationOwnershipTransfers)
        .where(
          and(
            eq(organizationOwnershipTransfers.organizationId, data.organizationId),
            eq(organizationOwnershipTransfers.proposedOwnerUserId, user.id),
          ),
        ),
    { idempotent: true },
  );
  return { success: true };
}
