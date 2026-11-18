/**
 * Organization members: listing, adding and removing. An Organization pays
 * one seat per member, so adding a member first buys their seat and removing
 * one gives it back from the next period (billing's organization-seats).
 */

import type { Database } from "@orbmeet/db";
import {
  organizationMembers,
  organizations,
  spaces,
  spaceMembers,
  users,
} from "@orbmeet/db/schema";
import { and, asc, eq, gt, isNull, or, sql } from "drizzle-orm";
import { canGrantOrganizationAdmin } from "@/modules/organizations/contract/roles";
import {
  addOrganizationMemberSchema,
  listOrganizationMembersSchema,
  removeOrganizationMemberSchema,
} from "@/modules/organizations/contract/schemas";
import { Errors } from "@/lib/app-errors";
import { generateId } from "@/lib/ids";
import { decodeTupleCursor, encodeTupleCursor } from "@/lib/keyset-cursor";
import { logError } from "@/lib/logger";
import { normalizeEmail } from "@/modules/identity/contract/auth/email-normalization";
import type { OrganizationRole } from "@/modules/organizations/contract/types";
import { getRunChanges, withD1Retry } from "@/platform/database/db-utils";
import { enforceRateLimit } from "@/platform/http/rate-limit.server";
import { loadOrganizationPlan, organizationHasOpenSeatSql } from "@/modules/billing/server/entitlements.server";
import {
  reserveOrganizationSeat,
  SeatChangeRefusedError,
  syncOrganizationSeats,
} from "@/modules/billing/server/organization-seats.server";
import type * as v from "valibot";
import type { AuthFnContext } from "@/app/bootstrap/middleware";
import { runSerially, type SerialTask } from "@/app/serial/serial";
import { assertOrganizationRole, findOrganizationMembership, retainsOrganizationAuthoritySql } from "./authority.server";

/**
 * Add the account with this email as a member, only while the Organization
 * has a paid seat open for them. The seat check runs inside the insert, so a
 * concurrent join or a lapsed subscription cannot slip past it.
 */
export async function insertOrganizationMemberByEmail(
  db: Database,
  params: {
    organizationId: string;
    normalizedEmail: string;
    membershipId: string;
    role: "admin" | "member";
    joinedAt: Date;
    actorUserId?: string;
  },
): Promise<boolean> {
  const { organizationId, normalizedEmail, membershipId, role, joinedAt } = params;
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
            organizationHasOpenSeatSql(organizationId),
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

function seatRefusalMessage(error: SeatChangeRefusedError): string {
  switch (error.refusal) {
    case "payment_failed":
      return "The Organization's payment method was declined. Update it in the billing portal, then try again.";
    case "not_active":
      return "The Organization's subscription is ending or not active, so no seats can be added. Resume it in the billing portal first.";
    case "above_maximum":
      return "The Organization's plan allows no more seats.";
    case "below_floor":
      // Only a decrease meets this, and decreases are never refused to the user.
      return "The Organization's seats could not be changed. Try again later.";
  }
}

/**
 * Invite someone into the Organization, buying their seat first. Runs in the
 * Organization's serial scope, after any other change to its seats.
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
  // Re-inviting an existing member is idempotent and buys no seat.
  if (existingMembership) return { success: true as const };

  if ((await loadOrganizationPlan(db, organizationId)) !== "organization") {
    throw Errors.PLAN_LIMIT_REACHED("An active Organization subscription is required to add members.");
  }
  const target = await db.query.users.findFirst({
    where: { normalizedEmail },
    columns: { id: true, deletionStartedAt: true },
  });
  if (!target || target.deletionStartedAt) return { success: true as const };

  try {
    await reserveOrganizationSeat(db, env, organizationId);
  } catch (error) {
    if (error instanceof SeatChangeRefusedError) throw Errors.CONFLICT(seatRefusalMessage(error));
    throw error;
  }

  const added = await insertOrganizationMemberByEmail(db, {
    organizationId,
    normalizedEmail,
    membershipId: generateId("ORGANIZATION_MEMBER"),
    role,
    joinedAt: new Date(),
    actorUserId,
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

/** Remove a member and give back their seat; runs in the Organization's serial scope. */
export async function removeOrganizationMember(
  db: Database,
  env: Env,
  task: Extract<SerialTask, { kind: "removeOrganizationMember" }>,
): Promise<{ success: true; removed: boolean }> {
  const { organizationId, actorUserId, memberUserId } = task;
  const caller = await assertOrganizationRole(db, organizationId, actorUserId, "admin");
  const organization = await db.query.organizations.findFirst({
    where: { id: organizationId },
    columns: { ownerId: true },
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
      "Remove this person from every Organization-funded Space before removing them from the Organization.",
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
        "Remove this person from every Organization-funded Space before removing them from the Organization.",
      );
    }
    return { success: true as const, removed: false };
  }

  // The member is gone either way. A seat Polar would not lower now stays
  // paid until the daily reconciliation lowers it.
  try {
    await syncOrganizationSeats(db, env, organizationId);
  } catch (error) {
    logError("[organizations] Could not lower seats after removing a member", { organizationId }, error);
  }
  return { success: true as const, removed: true };
}
