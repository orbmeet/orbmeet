/**
 * Organization members: listing, adding (which may buy a seat) and removing.
 *
 * Paid seats only ever go up here. A seat bought for an invitation that then
 * fails stays as paid headroom for the next one, as a removed member's seat
 * does; the subscription webhook and the daily reconciliation keep the stored
 * ceiling equal to what Paddle bills.
 */

import type { Database } from "@orbmeet/db";
import {
  organizationMembers,
  organizations,
  spaces,
  spaceMembers,
  users,
} from "@orbmeet/db/schema";
import { and, asc, count, eq, gt, isNull, or, sql } from "drizzle-orm";
import { canGrantOrganizationAdmin } from "@/modules/organizations/contract/roles";
import {
  addOrganizationMemberSchema,
  listOrganizationMembersSchema,
  removeOrganizationMemberSchema,
} from "@/modules/organizations/contract/schemas";
import { Errors } from "@/lib/app-errors";
import { generateId } from "@/lib/ids";
import { decodeTupleCursor, encodeTupleCursor } from "@/lib/keyset-cursor";
import { normalizeEmail } from "@/modules/identity/contract/auth/email-normalization";
import type { OrganizationRole } from "@/modules/organizations/contract/types";
import { getRunChanges, withD1Retry } from "@/platform/database/db-utils";
import { enforceRateLimit } from "@/platform/http/rate-limit.server";
import { updateSubscriptionQuantity } from "@/modules/billing/server/paddle";
import { configuredPaddlePriceId } from "@/modules/billing/server/paddle-config";
import type * as v from "valibot";
import type { AuthFnContext } from "@/app/bootstrap/middleware";
import { runSerially, type SerialTask } from "@/app/serial/serial";
import { assertOrganizationRole, findOrganizationMembership, retainsOrganizationAuthoritySql } from "./authority.server";

export async function insertOrganizationMemberByEmailWithinLimit(
  db: Database,
  params: {
    organizationId: string;
    normalizedEmail: string;
    membershipId: string;
    role: "admin" | "member";
    joinedAt: Date;
    licenseLimit: number;
    actorUserId?: string;
  },
): Promise<boolean> {
  const { organizationId, normalizedEmail, membershipId, role, joinedAt, licenseLimit } =
    params;
  const [insertResult] = await db.batch([
    db.insert(organizationMembers).select(
      db
        .select({
          id: sql`${membershipId}`.as("id"),
          organizationId: sql`${organizationId}`.as("organization_id"),
          userId: users.id,
          role: sql`${role}`.as("role"),
          joinedAt: sql`${Math.floor(joinedAt.getTime() / 1000)}`.as("joined_at"),
        })
        .from(users)
        .where(
          and(
            eq(users.normalizedEmail, normalizedEmail),
            isNull(users.deletionStartedAt),
            params.actorUserId
              ? retainsOrganizationAuthoritySql(
                  organizationId,
                  params.actorUserId,
                  role === "admin",
                )
              : undefined,
            sql`exists (select 1 from ${organizations} paid_org
              where paid_org.id = ${organizationId} and paid_org.plan = 'organization'
                and paid_org.subscription_status in ('active', 'trialing')
                and paid_org.paddle_subscription_id is not null
                and paid_org.license_limit >= ${licenseLimit})`,
            sql`(
              select count(*) from ${organizationMembers}
              where ${organizationMembers.organizationId} = ${organizationId}
            ) < ${licenseLimit}`,
            sql`not exists (
              select 1 from ${organizationMembers}
              where ${organizationMembers.organizationId} = ${organizationId}
                and ${organizationMembers.userId} = ${users.id}
            )`,
          ),
        ),
    ),
  ]);

  return getRunChanges(insertResult) > 0;
}

const organizationMemberRank = sql<number>`CASE WHEN ${organizations.ownerId} = ${organizationMembers.userId} THEN 0 WHEN ${organizationMembers.role} = 'admin' THEN 1 ELSE 2 END`;

export async function listOrganizationMembersImpl({
  data,
  context: { user, db },
}: {
  data: v.InferOutput<typeof listOrganizationMembersSchema>;
  context: AuthFnContext;
}) {
  const membership = await assertOrganizationRole(db, data.organizationId, user.id, "member");
  const canViewPrivateRoster = membership.role === "owner" || membership.role === "admin";

  // Keyset on (rank, name, id), the cursor carrying the values it was issued
  // at: an offset drifted with every join and removal. A rename or role change
  // can still move a member across it, which the client absorbs
  // (`keepLastCopyPerId`).
  const cursor = data.cursor ? decodeTupleCursor(data.cursor, ["number", "string", "string"]) : null;
  if (data.cursor && !cursor) throw Errors.VALIDATION("Invalid member cursor");

  const rows = await db
    .select({
      id: organizationMembers.id,
      userId: organizationMembers.userId,
      role: sql<OrganizationRole>`CASE WHEN ${organizations.ownerId} = ${organizationMembers.userId} THEN 'owner' ELSE ${organizationMembers.role} END`,
      rank: organizationMemberRank,
      joinedAt: organizationMembers.joinedAt,
      userName: users.name,
      userEmail: users.email,
      userImage: users.image,
    })
    .from(organizationMembers)
    .innerJoin(organizations, eq(organizationMembers.organizationId, organizations.id))
    .innerJoin(users, eq(organizationMembers.userId, users.id))
    .where(
      and(
        eq(organizationMembers.organizationId, data.organizationId),
        cursor
          ? or(
              gt(organizationMemberRank, cursor[0]),
              and(eq(organizationMemberRank, cursor[0]), gt(users.name, cursor[1])),
              and(eq(organizationMemberRank, cursor[0]), eq(users.name, cursor[1]), gt(organizationMembers.id, cursor[2])),
            )
          : undefined,
      ),
    )
    .orderBy(organizationMemberRank, asc(users.name), asc(organizationMembers.id))
    .limit(data.limit + 1);

  const hasMore = rows.length > data.limit;
  const page = hasMore ? rows.slice(0, data.limit) : rows;
  const last = page.at(-1);

  return {
    members: page.map((member) => ({
      id: member.id,
      userId: member.userId,
      role: member.role,
      joinedAt: member.joinedAt,
      user: {
        id: member.userId,
        name: member.userName,
        email: canViewPrivateRoster ? member.userEmail : "",
        image: canViewPrivateRoster ? member.userImage : null,
      },
    })),
    nextCursor: hasMore && last
      ? encodeTupleCursor([last.rank, last.userName, last.id])
      : undefined,
  };
}

export async function addOrganizationMemberImpl({
  data,
  context: { user, env },
}: {
  data: v.InferOutput<typeof addOrganizationMemberSchema>;
  context: AuthFnContext;
}) {
  await enforceRateLimit(env, `organization:addMember:${user.id}`);
  return runSerially(env, {
    kind: "addOrganizationMember",
    organizationId: data.organizationId,
    actorUserId: user.id,
    email: data.email,
    role: data.role,
  }, { callerWaits: true });
}

/**
 * Invite someone into the Organization, buying a seat when every one is
 * taken. Runs in the Organization's serial scope, after any other change to
 * its seats, so its reads and writes are not interleaved with one.
 */
export async function addOrganizationMember(
  db: Database,
  env: Env,
  task: Extract<SerialTask, { kind: "addOrganizationMember" }>,
): Promise<{ success: true }> {
  const { organizationId, actorUserId, role } = task;
  const caller = await assertOrganizationRole(db, organizationId, actorUserId, "admin");
  if (role === "admin" && !canGrantOrganizationAdmin(caller.role)) {
    throw Errors.FORBIDDEN();
  }

  const organization = await db.query.organizations.findFirst({
    where: { id: organizationId },
    columns: {
      id: true,
      plan: true,
      subscriptionStatus: true,
      licenseLimit: true,
      paddleSubscriptionId: true,
    },
  });
  if (!organization) throw Errors.NOT_FOUND("Organization");

  const normalizedEmail = normalizeEmail(task.email);
  const [existingMembership] = await db
    .select({ id: organizationMembers.id })
    .from(organizationMembers)
    .innerJoin(users, eq(users.id, organizationMembers.userId))
    .where(
      and(
        eq(organizationMembers.organizationId, organizationId),
        eq(users.normalizedEmail, normalizedEmail),
      ),
    )
    .limit(1);
  // Re-inviting an existing member is idempotent and consumes no new
  // license, including when every license is currently assigned.
  if (existingMembership) return { success: true as const };

  const [{ value: memberCount } = { value: 0 }] = await db
    .select({ value: count() })
    .from(organizationMembers)
    .where(eq(organizationMembers.organizationId, organizationId));
  if (
    organization.plan !== "organization" ||
    !organization.paddleSubscriptionId ||
    !["active", "trialing"].includes(organization.subscriptionStatus ?? "")
  ) {
    throw Errors.PLAN_LIMIT_REACHED(
      "An active Organization subscription is required to add members.",
    );
  }
  const target = await db.query.users.findFirst({
    where: { normalizedEmail },
    columns: { id: true, deletionStartedAt: true },
  });
  if (!target || target.deletionStartedAt) return { success: true as const };
  const licenseLimit = Math.max(organization.licenseLimit, memberCount + 1);
  if (licenseLimit > organization.licenseLimit) {
    const priceId = configuredPaddlePriceId(env.PADDLE_PRICE_ID_ORG_SEAT);
    if (!env.PADDLE_API_KEY || !priceId)
      throw Errors.CONFIG_ERROR("Organization billing is not configured.");
    await updateSubscriptionQuantity(
      env.PADDLE_API_KEY,
      organization.paddleSubscriptionId,
      priceId,
      licenseLimit,
    );
    const updated = await db
      .update(organizations)
      .set({ licenseLimit })
      .where(
        and(
          eq(organizations.id, organizationId),
          eq(organizations.paddleSubscriptionId, organization.paddleSubscriptionId),
          eq(organizations.plan, "organization"),
          retainsOrganizationAuthoritySql(organizationId, actorUserId, role === "admin"),
        ),
      );
    if (!getRunChanges(updated))
      throw Errors.CONFLICT("Organization billing changed; retry the invitation.");
  }

  const now = new Date();
  const membershipId = generateId("ORGANIZATION_MEMBER");
  const added = await insertOrganizationMemberByEmailWithinLimit(db, {
    organizationId: organizationId,
    normalizedEmail,
    membershipId,
    role: role,
    joinedAt: now,
    licenseLimit,
    actorUserId: actorUserId,
  });
  if (!added) {
    await assertOrganizationRole(
      db,
      organizationId,
      actorUserId,
      role === "admin" ? "owner" : "admin",
    );
    throw Errors.CONFLICT("Organization membership or billing changed; retry the invitation.");
  }

  // Deliberately identical for a newly added member, an existing member,
  // and an email with no account. Direct membership remains observable to
  // the Organization's administrators through the member list—as it must—
  // but this endpoint is no longer a negative account-existence oracle.
  return { success: true as const };
}

export async function removeOrganizationMemberImpl({
  data,
  context: { user, env },
}: {
  data: v.InferOutput<typeof removeOrganizationMemberSchema>;
  context: AuthFnContext;
}) {
  await enforceRateLimit(env, `organization:removeMember:${user.id}`);
  return runSerially(env, {
    kind: "removeOrganizationMember",
    organizationId: data.organizationId,
    actorUserId: user.id,
    memberUserId: data.memberUserId,
  }, { callerWaits: true });
}

/** Release a member's seat; runs in the Organization's serial scope. */
export async function removeOrganizationMember(
  db: Database,
  task: Extract<SerialTask, { kind: "removeOrganizationMember" }>,
): Promise<{ success: true; removed: boolean }> {
  const { organizationId, actorUserId, memberUserId } = task;
  const caller = await assertOrganizationRole(db, organizationId, actorUserId, "admin");
  const organization = await db.query.organizations.findFirst({
    where: { id: organizationId },
    columns: { ownerId: true, paddleSubscriptionId: true },
  });
  if (!organization) throw Errors.NOT_FOUND("Organization");
  if (memberUserId === organization.ownerId) {
    throw Errors.VALIDATION("Transfer ownership before removing the Organization owner.");
  }
  const membership = await findOrganizationMembership(db, organizationId, memberUserId);
  if (!membership) return { success: true as const, removed: false };
  if (membership.role === "admin" && caller.role !== "owner") {
    throw Errors.FORBIDDEN("Only the Organization owner can remove an admin.");
  }

  const licensedSpace = await db
    .select({ id: spaceMembers.id })
    .from(spaceMembers)
    .innerJoin(spaces, eq(spaces.id, spaceMembers.spaceId))
    .where(
      and(
        eq(spaces.organizationId, organizationId),
        eq(spaceMembers.userId, memberUserId),
      ),
    )
    .limit(1);
  if (licensedSpace.length > 0) {
    throw Errors.VALIDATION(
      "Remove this person from every Organization-funded Space before releasing their license.",
    );
  }

  const deleted = await withD1Retry(
    () =>
      db.delete(organizationMembers).where(
        and(
          eq(organizationMembers.id, membership.id),
          eq(organizationMembers.organizationId, organizationId),
          retainsOrganizationAuthoritySql(
            organizationId,
            actorUserId,
            membership.role === "admin",
          ),
          // Serialize license release with the admission statement itself. If a
          // Space membership won the race, the license must remain allocated.
          sql`not exists (
        select 1
        from ${spaceMembers} member
        inner join ${spaces} funded_space on funded_space.id = member.space_id
        where funded_space.organization_id = ${organizationId}
          and member.user_id = ${memberUserId}
      )`,
        ),
      ),
    { idempotent: true },
  );
  if (getRunChanges(deleted) === 0) {
    const racedSpaceAdmission = await db
      .select({ id: spaceMembers.id })
      .from(spaceMembers)
      .innerJoin(spaces, eq(spaces.id, spaceMembers.spaceId))
      .where(
        and(
          eq(spaces.organizationId, organizationId),
          eq(spaceMembers.userId, memberUserId),
        ),
      )
      .limit(1);
    if (racedSpaceAdmission.length > 0) {
      throw Errors.VALIDATION(
        "Remove this person from every Organization-funded Space before releasing their license.",
      );
    }
    return { success: true as const, removed: false };
  }

  // Removing a member releases an assigned seat; purchased headroom remains
  // available for the next invitation and is never silently downgraded.
  return { success: true as const, removed: true };
}
