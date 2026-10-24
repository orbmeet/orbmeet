/**
 * Who may do what in an Organization: roles, licenses, and the SQL fences
 * other writes use to re-check authority in the same statement.
 */

import type { Database } from "@orbmeet/db";
import { organizationMembers, organizations, users } from "@orbmeet/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { hasMinOrganizationRole } from "@/modules/organizations/contract/roles";
import { Errors } from "@/lib/app-errors";
import type { OrganizationRole } from "@/modules/organizations/contract/types";

export function findOrganizationMembership(db: Database, organizationId: string, userId: string) {
  return db.query.organizationMembers.findFirst({
    where: { RAW: (row) => and(eq(row.organizationId, organizationId), eq(row.userId, userId))! },
  });
}

/**
 * An Organization membership is a paid license, not content access. Direct
 * Space membership remains the least-privilege content boundary.
 */
export async function hasOrganizationLicense(
  db: Database,
  organizationId: string,
  userId: string,
): Promise<boolean> {
  return Boolean(await findOrganizationMembership(db, organizationId, userId));
}

/**
 * Add a registered user by normalized email without exposing whether that
 * email exists. The license count and duplicate check are part of the INSERT,
 * so the database remains authoritative if another writer races this request.
 */
export function retainsOrganizationAuthoritySql(
  organizationId: string,
  actorUserId: string,
  ownerOnly: boolean,
) {
  return sql`exists (
    select 1 from ${organizations} authority_org
    inner join ${users} actor on actor.id = ${actorUserId} and actor.deletion_started_at is null
    where authority_org.id = ${organizationId}
      and (authority_org.owner_id = ${actorUserId} or (${!ownerOnly} and exists (
        select 1 from ${organizationMembers} authority_member
        where authority_member.organization_id = authority_org.id
          and authority_member.user_id = ${actorUserId} and authority_member.role = 'admin'
      )))
  )`;
}

export function effectiveOrganizationRole(
  ownerId: string,
  userId: string,
  delegatedRole: "admin" | "member" | null,
): OrganizationRole | null {
  if (ownerId === userId) return "owner";
  return delegatedRole;
}

export async function assertOrganizationRole(
  db: Database,
  organizationId: string,
  userId: string,
  min: OrganizationRole = "member",
) {
  const [row] = await db
    .select({
      organizationId: organizations.id,
      ownerId: organizations.ownerId,
      membershipId: organizationMembers.id,
      membershipUserId: organizationMembers.userId,
      delegatedRole: organizationMembers.role,
      joinedAt: organizationMembers.joinedAt,
    })
    .from(organizations)
    .leftJoin(
      organizationMembers,
      and(
        eq(organizationMembers.organizationId, organizations.id),
        eq(organizationMembers.userId, userId),
      ),
    )
    .where(eq(organizations.id, organizationId))
    .limit(1);

  const role = row ? effectiveOrganizationRole(row.ownerId, userId, row.delegatedRole) : null;
  if (!row || !role || !hasMinOrganizationRole(role, min)) {
    throw Errors.FORBIDDEN();
  }
  return {
    id: row.membershipId,
    organizationId: row.organizationId,
    userId: row.membershipUserId ?? userId,
    role,
    joinedAt: row.joinedAt,
  };
}

/**
 * Write-time authority fence for Organization-funded mutations.
 *
 * Organization ownership is authoritative even if its projected membership row
 * is missing. Delegated administrators, however, must still hold their current
 * Organization membership when the guarded statement executes.
 */
export function retainsOrganizationAdminSql(organizationId: string, userId: string) {
  return sql`exists (
    select 1
    from ${organizations} governed_organization
    where governed_organization.id = ${organizationId}
      and (
        governed_organization.owner_id = ${userId}
        or exists (
          select 1
          from ${organizationMembers} actor_organization_membership
          where actor_organization_membership.organization_id = governed_organization.id
            and actor_organization_membership.user_id = ${userId}
            and actor_organization_membership.role = 'admin'
        )
      )
  )`;
}
