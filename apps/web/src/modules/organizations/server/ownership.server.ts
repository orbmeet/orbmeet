/**
 * Moving an Organization to a new owner: a nomination the recipient accepts
 * or declines. The Organization is its own billing customer, so its
 * subscription stays where it is; only who manages it changes.
 */

import { organizationMembers, organizationOwnershipTransfers, organizations, users } from "@orbmeet/db/schema";
import { and, eq, gt, sql } from "drizzle-orm";
import {
  getOrganizationSchema,
  transferOrganizationOwnershipSchema,
} from "@/modules/organizations/contract/schemas";
import { Errors } from "@/lib/app-errors";
import { syncOrganizationBillingOwner } from "@/modules/billing/server/customers.server";
import { getRunChanges, withD1Retry } from "@/platform/database/db-utils";
import { enforceRateLimit } from "@/platform/http/rate-limit.server";
import type * as v from "valibot";
import type { AuthFnContext } from "@/app/bootstrap/middleware";
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
      columns: { deletionStartedAt: true },
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
    !membership ||
    otherOrganization
  ) {
    throw Errors.VALIDATION(
      "Choose a member of this Organization who does not own another Organization.",
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

  // One guarded statement: the nomination is still live, the recipient is
  // still a member and not being deleted, and owns no other Organization.
  // A retry after a lost response finds the swap already made.
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const transferred = await withD1Retry(() => db.run(sql`
    update ${organizations}
    set owner_id = ${user.id}, updated_at = ${nowSeconds}
    where ${organizations.id} = ${data.organizationId}
      and ${organizations.ownerId} = ${pending.requestedByUserId}
      and exists (
        select 1 from ${organizationMembers}
        where ${organizationMembers.organizationId} = ${data.organizationId}
          and ${organizationMembers.userId} = ${user.id}
      )
      and exists (
        select 1 from ${users}
        where ${users.id} = ${user.id} and ${users.deletionStartedAt} is null
      )
      and exists (
        select 1 from ${organizationOwnershipTransfers}
        where ${organizationOwnershipTransfers.organizationId} = ${data.organizationId}
          and ${organizationOwnershipTransfers.requestedByUserId} = ${pending.requestedByUserId}
          and ${organizationOwnershipTransfers.proposedOwnerUserId} = ${user.id}
          and ${organizationOwnershipTransfers.expiresAt} > ${nowSeconds}
      )
      and not exists (
        select 1 from ${organizations} other
        where other.owner_id = ${user.id} and other.id <> ${data.organizationId}
      )
  `), { idempotent: true });
  if (getRunChanges(transferred) === 0) {
    const current = await db.query.organizations.findFirst({
      where: { id: data.organizationId },
      columns: { ownerId: true },
    });
    if (current?.ownerId !== user.id) {
      throw Errors.VALIDATION("Ownership could not be transferred. Ask the owner to nominate you again.");
    }
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
  await syncOrganizationBillingOwner(db, env, data.organizationId);
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
