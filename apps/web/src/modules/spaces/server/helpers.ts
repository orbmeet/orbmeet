import { organizationMembers, organizations, spaces, spaceMembers, users } from "@orbmeet/db/schema";
import { eq, and, desc, isNull, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { getPlanLimits, PLAN_LIMITS } from "@/modules/billing/contract/plan-limits";
import { Errors } from "@/lib/app-errors";
import type { OrganizationRole } from "@/modules/organizations/contract/types";
import type { PlanLimits } from "@/modules/billing/contract/plan-limits";
import type { SubscriptionTier } from "@/modules/billing/contract/types";
import type { SpaceMembershipRole, SpaceRole } from "@/modules/spaces/contract/types";
import { compareCodeUnitStrings } from "@/lib/code-unit-order";
import type { Database } from "@orbmeet/db";
import { requireSpaceSlug } from "@/modules/spaces/contract/slug";

function effectiveOrganizationRole(
  organizationOwnerId: string | null,
  userId: string,
  delegatedRole: OrganizationRole | null,
): OrganizationRole | null {
  if (organizationOwnerId === userId) return "owner";
  return delegatedRole;
}

/**
 * Every shared space a user directly belongs to, most-recently-active first.
 * The personal space is deliberately excluded: it surfaces as "your" views,
 * never as a listed Space. An Organization license permits assignment to its
 * funded Spaces, but it is not Space membership: co-workers/teachers must not see
 * each other's Spaces unless they have a direct space_members row.
 */
export async function selectSpacesForUser(db: Database, userId: string) {
  const directRows = await db
    .select({
      space: spaces,
      membershipRole: spaceMembers.role,
      organizationOwnerId: organizations.ownerId,
      organizationName: organizations.name,
      delegatedOrganizationRole: organizationMembers.role,
      organizationAdminCount: sql<number>`(
        select count(*) from space_members capability_admin
        where capability_admin.space_id = ${spaces.id}
          and capability_admin.role = 'admin'
      )`,
    })
    .from(spaceMembers)
    .innerJoin(spaces, eq(spaceMembers.spaceId, spaces.id))
    .leftJoin(organizations, eq(organizations.id, spaces.organizationId))
    .leftJoin(
      organizationMembers,
      and(
        eq(organizationMembers.organizationId, spaces.organizationId),
        eq(organizationMembers.userId, userId),
      ),
    )
    .where(and(
      eq(spaceMembers.userId, userId),
      eq(spaces.kind, "shared"),
      isNull(spaces.archivedAt),
    ))
    .orderBy(desc(spaces.updatedAt), desc(spaces.id));

  const byId = new Map<
    string,
    ReturnType<typeof buildSpaceAccess>
      & (typeof directRows)[number]["space"]
      & { organizationName: string | null }
  >();
  for (const row of directRows) {
    const organizationRole = effectiveOrganizationRole(
      row.organizationOwnerId,
      userId,
      row.delegatedOrganizationRole,
    );
    byId.set(row.space.id, {
      ...row.space,
      slug: requireSpaceSlug(row.space.slug),
      organizationName: row.organizationName,
      ...buildSpaceAccess(
        row.space,
        row.membershipRole,
        organizationRole,
        userId,
        row.organizationAdminCount,
      ),
    });
  }

  return Array.from(byId.values())
    .map((space) => ({ ...space, slug: requireSpaceSlug(space.slug) }))
    .sort((a, b) => {
      const timeDiff = b.updatedAt.getTime() - a.updatedAt.getTime();
      return timeDiff !== 0 ? timeDiff : compareCodeUnitStrings(b.id, a.id);
    });
}

/**
 * The role people see for a `space_members` row: "owner" for the member the
 * Space names as its owner, otherwise the stored `admin` or `member`. The
 * owner is stored once, on the Space; the query must join `spaces`.
 */
export const spaceRoleSql = sql<SpaceRole>`(case
  when ${spaces.ownerUserId} = ${spaceMembers.userId} then 'owner'
  else ${spaceMembers.role}
end)`;

/**
 * True for the `space_members` row of the member its Space names as owner.
 * Correlated with the outer query's `space_members` row.
 */
export const isSpaceOwnerMembershipSql = sql`exists (
  select 1 from ${spaces} owned_space
  where owned_space.id = ${spaceMembers.spaceId}
    and owned_space.owner_user_id = ${spaceMembers.userId}
)`;

/**
 * A user's membership in a Space, with the role people see (see
 * `spaceRoleSql`). Undefined if they are not a member.
 */
export async function findSpaceMembership(db: Database, spaceId: string, userId: string) {
  const [membership] = await db
    .select({
      id: spaceMembers.id,
      spaceId: spaceMembers.spaceId,
      userId: spaceMembers.userId,
      role: spaceRoleSql,
      joinedAt: spaceMembers.joinedAt,
    })
    .from(spaceMembers)
    .innerJoin(spaces, eq(spaces.id, spaceMembers.spaceId))
    .where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.userId, userId)))
    .limit(1);
  return membership;
}

interface SpaceOwnershipRecord {
  kind: "personal" | "shared";
  ownerUserId: string | null;
  organizationId: string | null;
}

function buildSpaceAccess(
  space: SpaceOwnershipRecord,
  membershipRole: SpaceMembershipRole | null,
  organizationRole: OrganizationRole | null,
  userId: string,
  organizationAdminCount = 0,
) {
  // Ownership is stored once, on the Space. A member it names is its owner;
  // anyone else's membership row cannot claim ownership.
  const isOwner = membershipRole !== null && space.ownerUserId === userId;
  const directRole: SpaceRole | null = isOwner ? "owner" : membershipRole;
  const isOrganizationSpace = space.organizationId !== null;
  const isOrganizationManager =
    organizationRole === "owner" || organizationRole === "admin";
  const canView = membershipRole !== null;
  // Managing is holding an admin membership — the same rule as
  // `retainsSpaceManagerSql`. The owner always holds one: creation and
  // transfer write it, and role changes never touch the owner's row.
  const canManage = membershipRole === "admin";
  const isLastOrganizationAdmin =
    isOrganizationSpace && membershipRole === "admin" && organizationAdminCount <= 1;
  // Organization roles are a governance axis, not content membership. The only
  // Space capability they grant without a direct space_members row is deletion,
  // so org managers can reclaim org-funded Spaces without reading their content.

  if (space.kind === "personal") {
    // A personal space has exactly one member — its owner — and no membership
    // management, transfer, or standalone deletion (it lives and dies with
    // the account).
    return {
      directRole,
      organizationRole,
      capabilities: {
        canView: isOwner,
        canManage: isOwner,
        canManageMembers: false,
        canGrantAdmins: false,
        canStartMeetings: isOwner,
        canDelete: false,
        canTransferOwnership: false,
        canLeave: false,
      },
    };
  }

  return {
    directRole,
    organizationRole,
    capabilities: {
      canView,
      canManage,
      canManageMembers: canManage,
      canGrantAdmins: isOwner || (canManage && isOrganizationSpace && organizationRole === "owner"),
      canStartMeetings: canView,
      canDelete: isOwner || (isOrganizationSpace && isOrganizationManager),
      canTransferOwnership: isOwner && space.organizationId === null,
      canLeave: directRole !== null && !isOwner && !isLastOrganizationAdmin,
    },
  };
}

export async function getSpaceAccess(
  db: Database,
  spaceId: string,
  userId: string,
){
  const [row] = await db
    .select({
      spaceId: spaces.id,
      kind: spaces.kind,
      ownerUserId: spaces.ownerUserId,
      organizationId: spaces.organizationId,
      membershipRole: spaceMembers.role,
      organizationOwnerId: organizations.ownerId,
      delegatedOrganizationRole: organizationMembers.role,
      organizationAdminCount: sql<number>`(
        select count(*) from space_members capability_admin
        where capability_admin.space_id = ${spaces.id}
          and capability_admin.role = 'admin'
      )`,
    })
    .from(spaces)
    .leftJoin(organizations, eq(organizations.id, spaces.organizationId))
    .leftJoin(
      spaceMembers,
      and(
        eq(spaceMembers.spaceId, spaces.id),
        eq(spaceMembers.userId, userId),
      ),
    )
    .leftJoin(
      organizationMembers,
      and(
        eq(organizationMembers.organizationId, spaces.organizationId),
        eq(organizationMembers.userId, userId),
      ),
    )
    .where(
      and(
        eq(spaces.id, spaceId),
        isNull(spaces.archivedAt),
      ),
    )
    .limit(1);

  if (!row) return null;
  const organizationRole = effectiveOrganizationRole(
    row.organizationOwnerId,
    userId,
    row.delegatedOrganizationRole ?? null,
  );
  return {
    spaceId: row.spaceId,
    kind: row.kind,
    ownerUserId: row.ownerUserId,
    organizationId: row.organizationId,
    ...buildSpaceAccess(
      row,
      row.membershipRole ?? null,
      organizationRole,
      userId,
      row.organizationAdminCount,
    ),
  };
}

export type SpaceCapability =
  | "canView"
  | "canManage"
  | "canManageMembers"
  | "canGrantAdmins"
  | "canStartMeetings"
  | "canDelete"
  | "canTransferOwnership";

/** Write-time fence for content mutations available to every direct member. */
export function retainsSpaceViewerSql(spaceId: string, userId: string) {
  return sql`EXISTS (
    SELECT 1
    FROM space_members AS actor_membership
    INNER JOIN spaces AS viewed_space
      ON viewed_space.id = actor_membership.space_id
    WHERE actor_membership.space_id = ${spaceId}
      AND actor_membership.user_id = ${userId}
      AND viewed_space.archived_at IS NULL
      AND (
        viewed_space.kind = 'shared'
        OR (
          viewed_space.kind = 'personal'
          AND viewed_space.owner_user_id = ${userId}
        )
      )
  )`;
}

/**
 * The one SQL definition of "manages this Space": an admin of a live Space.
 * Its owner holds an admin membership, so this covers them too.
 *
 * It is the write-time authority fence for Space governance mutations —
 * read-time checks remain useful for clear errors and plan context, but every
 * mutation that relies on admin/owner authority embeds this predicate so a
 * concurrent demotion cannot land one final write — and the filter for every
 * read that lists what a user manages, so the two never disagree. `spaceId`
 * may be a column, correlating the check with an outer query.
 */
export function retainsSpaceManagerSql(spaceId: string | AnyColumn, userId: string) {
  return sql`EXISTS (
    SELECT 1
    FROM space_members AS actor_membership
    INNER JOIN spaces AS governed_space
      ON governed_space.id = actor_membership.space_id
    WHERE actor_membership.space_id = ${spaceId}
      AND actor_membership.user_id = ${userId}
      AND governed_space.archived_at IS NULL
      AND actor_membership.role = 'admin'
  )`;
}

/**
 * The one SQL definition of "the Space keeps a manager without `userId`":
 * another admin (owners hold admin memberships) whose account is not being
 * deleted. An account in
 * deletion still has its membership row until the deletion cascades it away,
 * so counting it would let the last real manager leave. Embedded in every
 * write that could remove a Space's last manager (leaving, removal, account
 * deletion) and in their preflights. `spaceId` may be a column or an aliased
 * column, correlating the check with an outer query.
 */
export function anotherSpaceManagerRemainsSql(spaceId: string | AnyColumn | SQL, userId: string): SQL {
  return sql`exists (
    select 1
    from ${spaceMembers} other_manager
    inner join ${users} active_manager on active_manager.id = other_manager.user_id
    where other_manager.space_id = ${spaceId}
      and other_manager.user_id <> ${userId}
      and other_manager.role = 'admin'
      and active_manager.deletion_started_at is null
  )`;
}

/**
 * Stronger write fence for creating or changing Space admins. A direct Space
 * admin may manage ordinary members, but may grant admin only when they also
 * own the funding Organization. This mirrors `canGrantAdmins` at the mutation
 * boundary so an Organization ownership transfer cannot race the write.
 */
export function retainsSpaceAdminGrantAuthoritySql(spaceId: string, userId: string) {
  return sql`EXISTS (
    SELECT 1
    FROM space_members AS actor_membership
    INNER JOIN spaces AS governed_space
      ON governed_space.id = actor_membership.space_id
    WHERE actor_membership.space_id = ${spaceId}
      AND actor_membership.user_id = ${userId}
      AND governed_space.archived_at IS NULL
      AND (
        governed_space.owner_user_id = ${userId}
        OR (
          actor_membership.role = 'admin'
          AND governed_space.organization_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM organizations AS governing_org
            WHERE governing_org.id = governed_space.organization_id
              AND governing_org.owner_id = ${userId}
          )
        )
      )
  )`;
}

/** Shared quota expression: deleted/archived Spaces are no longer active seats. */
export function activeOwnedSharedSpaceCountSql(userId: string) {
  return sql`(
    select count(*) from ${spaces} active_owned_space
    where active_owned_space.owner_user_id = ${userId}
      and active_owned_space.kind = 'shared'
      and active_owned_space.archived_at is null
  )`;
}

export async function assertSpaceCapability(
  db: Database,
  spaceId: string,
  userId: string,
  capability: SpaceCapability = "canView",
) {
  const access = await getSpaceAccess(db, spaceId, userId);
  if (!access?.capabilities[capability]) {
    throw Errors.FORBIDDEN();
  }
  return access;
}

export async function findEffectiveSpaceRole(
  db: Database,
  spaceId: string,
  userId: string,
): Promise<SpaceRole | null> {
  const access = await getSpaceAccess(db, spaceId, userId);
  if (!access?.capabilities.canView) return null;
  if (access.directRole === "owner") return "owner";
  if (access.capabilities.canManage) return "admin";
  return "member";
}

/** Resolve a user's plan limits, defaulting to the free plan if the row is gone. */
export async function resolveUserPlanLimits(
  db: Database,
  userId: string,
): Promise<PlanLimits> {
  const user = await db.query.users.findFirst({
    where: { id: userId },
    columns: { plan: true },
  });
  return getPlanLimits((user?.plan as SubscriptionTier) ?? "free");
}

/**
 * The one SQL definition of "this Space has room for another member": fewer
 * members than the `maxMembersPerSpace` of the plan funding the Space as the
 * statement runs — its Organization's plan for an Organization Space, its
 * owner's otherwise (no plan row reads as free, as `resolveSpaceMemberCap`
 * reads it). A cap resolved before the write can be stale when it runs — an
 * ownership transfer or a plan change in between — so every write that adds
 * a member embeds this predicate rather than a number.
 */
export function spaceHasMemberRoomSql(spaceId: string): SQL {
  const plan = sql`(
    select coalesce(
      case when funded_space.organization_id is not null
        then (select funding_org.plan from organizations funding_org
              where funding_org.id = funded_space.organization_id)
        else (select funding_owner.plan from users funding_owner
              where funding_owner.id = funded_space.owner_user_id)
      end,
      'free'
    )
    from spaces funded_space
    where funded_space.id = ${spaceId}
  )`;
  const tiers = Object.entries(PLAN_LIMITS) as Array<[SubscriptionTier, PlanLimits]>;
  const cap = sql`(case ${plan} ${sql.join(
    tiers.map(([tier, limits]) => sql`when ${tier} then ${limits.maxMembersPerSpace}`),
    sql` `,
  )} else ${PLAN_LIMITS.free.maxMembersPerSpace} end)`;
  return sql`(${cap} is null or (
    select count(*) from space_members counted_member
    where counted_member.space_id = ${spaceId}
  ) < ${cap})`;
}

/**
 * The maximum number of members a space may have, derived from the space owner's
 * plan (the space belongs to the owner). Returns null for unlimited. The owner
 * row counts toward the cap.
 */
export async function resolveSpaceMemberCap(
  db: Database,
  ownerUserId: string | null,
  organizationId?: string | null,
): Promise<number | null> {
  if (organizationId) {
    const organization = await db.query.organizations.findFirst({
      where: { id: organizationId },
      columns: { plan: true },
    });
    return getPlanLimits((organization?.plan as SubscriptionTier) ?? "free").maxMembersPerSpace;
  }
  if (!ownerUserId) throw Errors.VALIDATION("Space is missing its owner");
  return (await resolveUserPlanLimits(db, ownerUserId)).maxMembersPerSpace;
}

/** The member cap of the plan funding `spaceId` now; for messages, never for the write itself. */
export async function resolveCurrentSpaceMemberCap(
  db: Database,
  spaceId: string,
): Promise<number | null> {
  const space = await db.query.spaces.findFirst({
    where: { id: spaceId },
    columns: { ownerUserId: true, organizationId: true },
  });
  if (!space) throw Errors.NOT_FOUND("Space");
  return resolveSpaceMemberCap(db, space.ownerUserId, space.organizationId);
}

