/**
 * Organizations themselves: creating one, and listing a user's and their
 * Spaces. Membership, authority and ownership live beside this file.
 */

import type { Database } from "@orbmeet/db";
import {
  organizationMembers,
  organizationOwnershipTransfers,
  organizations,
  spaces,
  spaceMembers,
  users,
} from "@orbmeet/db/schema";
import { and, asc, desc, eq, gt, isNull, or, sql } from "drizzle-orm";
import {
  createOrganizationSchema,
  listOrganizationSpacesSchema,
} from "@/modules/organizations/contract/schemas";
import { Errors } from "@/lib/app-errors";
import { generateId } from "@/lib/ids";
import { getRunChanges } from "@/platform/database/db-utils";
import { enforceRateLimit } from "@/platform/http/rate-limit.server";
import { requireSpaceSlug } from "@/modules/spaces/contract/slug";
import { getSubscription } from "@/modules/billing/server/paddle";
import { configuredPaddlePriceId } from "@/modules/billing/server/paddle-config";
import type * as v from "valibot";
import type { AuthFnContext } from "@/app/bootstrap/middleware";
import { assertOrganizationRole, effectiveOrganizationRole } from "./authority.server";

export async function selectOrganizationsForUser(db: Database, userId: string) {
  const rows = await db
    .select({
      id: organizations.id,
      name: organizations.name,
      ownerId: organizations.ownerId,
      plan: organizations.plan,
      licenseLimit: organizations.licenseLimit,
      subscriptionStatus: organizations.subscriptionStatus,
      createdAt: organizations.createdAt,
      updatedAt: organizations.updatedAt,
      delegatedRole: organizationMembers.role,
    })
    .from(organizations)
    .leftJoin(
      organizationMembers,
      and(
        eq(organizationMembers.organizationId, organizations.id),
        eq(organizationMembers.userId, userId),
      ),
    )
    .where(or(eq(organizations.ownerId, userId), eq(organizationMembers.userId, userId)))
    .orderBy(asc(organizations.name), asc(organizations.id));

  return rows.map(({ delegatedRole, ownerId, ...organization }) => ({
    ...organization,
    ownerId,
    role: effectiveOrganizationRole(ownerId, userId, delegatedRole) ?? "member",
  }));
}

export async function getMyOrganizationsImpl({
  context: { user, db },
}: {
  context: AuthFnContext;
}) {
  const now = new Date();
  const [userOrganizations, ownershipTransfers] = await Promise.all([
    selectOrganizationsForUser(db, user.id),
    db
      .select({
        organizationId: organizationOwnershipTransfers.organizationId,
        organizationName: organizations.name,
        requestedByName: users.name,
        expiresAt: organizationOwnershipTransfers.expiresAt,
      })
      .from(organizationOwnershipTransfers)
      .innerJoin(
        organizations,
        and(
          eq(organizations.id, organizationOwnershipTransfers.organizationId),
          eq(organizations.ownerId, organizationOwnershipTransfers.requestedByUserId),
        ),
      )
      .innerJoin(users, eq(users.id, organizationOwnershipTransfers.requestedByUserId))
      .where(
        and(
          eq(organizationOwnershipTransfers.proposedOwnerUserId, user.id),
          gt(organizationOwnershipTransfers.expiresAt, now),
        ),
      )
      .orderBy(asc(organizations.name), asc(organizations.id)),
  ]);
  return { organizations: userOrganizations, ownershipTransfers };
}

export async function createOrganizationImpl({
  data,
  context: { user, env, db },
}: {
  data: v.InferOutput<typeof createOrganizationSchema>;
  context: AuthFnContext;
}) {
  await enforceRateLimit(env, `organization:create:${user.id}`);

  if (user.plan !== "organization") {
    throw Errors.PLAN_LIMIT_REACHED("Creating an Organization requires the Organization plan.");
  }

  const existing = await db.query.organizations.findFirst({
    where: { ownerId: user.id },
    columns: { id: true },
  });
  if (existing) return { organizationId: existing.id };

  const now = new Date();
  const orgId = generateId("ORGANIZATION");
  const memberId = generateId("ORGANIZATION_MEMBER");
  const billingUser = await db.query.users.findFirst({
    where: { id: user.id },
    columns: {
      paddleCustomerId: true,
      paddleSubscriptionId: true,
      subscriptionStatus: true,
      subscriptionUpdatedAt: true,
    },
  });

  // The license ceiling is the seat quantity the owner already pays for, not
  // the schema default: creation requires the Organization plan, so an
  // Organization founded after subscribing would otherwise invite against 25
  // seats and the first member add would push Paddle down to memberCount + 1.
  // Convergence is the webhook's and reconciliation's job, so a Paddle
  // failure here must not block creation.
  let licenseLimit = 1;
  const ownerPriceId = billingUser?.paddleSubscriptionId
    ? configuredPaddlePriceId(env.PADDLE_PRICE_ID_ORG_SEAT)
    : null;
  if (billingUser?.paddleSubscriptionId && env.PADDLE_API_KEY && ownerPriceId) {
    try {
      const subscription = await getSubscription(
        env.PADDLE_API_KEY,
        billingUser.paddleSubscriptionId,
      );
      const paidQuantity = subscription.items.find(
        ({ price }) => price.id === ownerPriceId,
      )?.quantity;
      if (Number.isSafeInteger(paidQuantity) && (paidQuantity ?? 0) >= 1) {
        licenseLimit = paidQuantity!;
      }
    } catch {
      // Keep the default ceiling; the next subscription event or
      // reconciliation pass will align it.
    }
  }

  try {
    const [organizationInsert] = await db.batch([
      db.run(sql`
          insert into ${organizations} (
            id, name, owner_id, plan, paddle_customer_id,
            paddle_subscription_id, subscription_status,
            subscription_updated_at, license_limit, archived_at,
            created_at, updated_at
          )
          select
            ${orgId}, ${data.name}, ${user.id}, 'organization',
            ${billingUser?.paddleCustomerId ?? null},
            ${billingUser?.paddleSubscriptionId ?? null},
            ${billingUser?.subscriptionStatus ?? null},
            ${billingUser?.subscriptionUpdatedAt?.getTime() ?? null},
            ${licenseLimit}, null, ${Math.floor(now.getTime() / 1000)},
            ${Math.floor(now.getTime() / 1000)}
          from ${users} creating_owner
          where creating_owner.id = ${user.id}
            and creating_owner.deletion_started_at is null
        `),
      db.run(sql`
          insert into ${organizationMembers} (
            id, organization_id, user_id, role, joined_at
          )
          select ${memberId}, ${orgId}, ${user.id}, 'admin',
            ${Math.floor(now.getTime() / 1000)}
          where exists (
            select 1 from ${organizations} created_organization
            where created_organization.id = ${orgId}
          )
        `),
    ]);
    if (getRunChanges(organizationInsert) === 0) {
      throw Errors.CONFLICT("Account deletion has started; Organization creation is unavailable.");
    }
  } catch (error) {
    // The owner unique index is the concurrency authority. A double-submit
    // returns the organization created by the winning request.
    const winner = await db.query.organizations.findFirst({
      where: { ownerId: user.id },
      columns: { id: true },
    });
    if (winner) return { organizationId: winner.id };
    throw error;
  }

  return { organizationId: orgId };
}

export async function selectOrganizationSpaces(
  db: Database,
  organizationId: string,
  viewerId: string,
) {
  const rows = await db
    .select({
      id: spaces.id,
      name: spaces.name,
      description: spaces.description,
      slug: spaces.slug,
      updatedAt: spaces.updatedAt,
      memberCount: sql<number>`(
        select count(*) from ${spaceMembers}
        where ${spaceMembers.spaceId} = ${spaces.id}
      )`,
      viewerRole: sql<"owner" | "admin" | "member" | null>`(
        select ${spaceMembers.role} from ${spaceMembers}
        where ${spaceMembers.spaceId} = ${spaces.id}
          and ${spaceMembers.userId} = ${viewerId}
        limit 1
      )`,
    })
    .from(spaces)
    .where(and(eq(spaces.organizationId, organizationId), isNull(spaces.archivedAt)))
    .orderBy(desc(spaces.updatedAt), asc(spaces.name));
  return rows.map((space) => ({ ...space, slug: requireSpaceSlug(space.slug) }));
}

export async function listOrganizationSpacesImpl({
  data,
  context: { user, db },
}: {
  data: v.InferOutput<typeof listOrganizationSpacesSchema>;
  context: AuthFnContext;
}) {
  await assertOrganizationRole(db, data.organizationId, user.id, "admin");

  return { spaces: await selectOrganizationSpaces(db, data.organizationId, user.id) };
}
