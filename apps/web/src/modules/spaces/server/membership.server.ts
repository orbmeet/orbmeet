/**
 * Server implementations behind the RPC declarations in this directory.
 * Split from the sibling RPC file so the declaration file carries no
 * DB/Drizzle imports and stays safe to include in client route graphs.
 */

import type { Database } from "@orbmeet/db";
import { organizationMembers, spaces, spaceMembers, users } from "@orbmeet/db/schema";
import { eq, and, asc, count, gt, or, sql, type SQL } from "drizzle-orm";
import {
  addMemberByEmailSchema,
  removeMemberSchema,
  leaveSpaceSchema,
  listMembersSchema,
  updateMemberRoleSchema,
  transferOwnershipSchema,
} from "@/modules/spaces/contract/schemas";
import { generateId } from "@/lib/ids";
import { decodeTupleCursor, encodeTupleCursor } from "@/lib/keyset-cursor";
import { normalizeEmail } from "@/modules/identity/contract/auth/email-normalization";
import { AppError, Errors } from "@/lib/app-errors";
import { getRunChanges, isUniqueConstraintError } from "@/platform/database/db-utils";
import { enforceRateLimit } from "@/platform/http/rate-limit.server";
import {
  activeOwnedSharedSpaceCountSql,
  anotherSpaceManagerRemainsSql,
  assertSpaceCapability,
  findSpaceMembership,
  isSpaceOwnerMembershipSql,
  retainsSpaceAdminGrantAuthoritySql,
  retainsSpaceManagerSql,
  resolveCurrentSpaceMemberCap,
  spaceHasMemberRoomSql,
  spaceRoleSql,
  resolveUserPlanLimits,
} from "./helpers";
import { recordSpaceAuditEvent } from "@/modules/spaces/server/audit.server";
import type * as v from "valibot";
import type { AuthFnContext } from "@/app/bootstrap/middleware";
import { SPACE_MEMBERSHIP_ROLES } from "@/modules/spaces/contract/types";
import { evictUserFromSpaceMeetings } from "./evict-space-meetings.server";
import { refreshSpaceAuthorityInOpenMeetings } from "@/modules/meetings/server/runtime/revoke.server";

// L2: stable ordering — owner first, then admins, then members; within each
//     group sort by joinedAt ascending (and id as a final tiebreaker).
const memberRoleRank = sql<number>`CASE
  WHEN ${isSpaceOwnerMembershipSql} THEN 0
  WHEN ${spaceMembers.role} = 'admin' THEN 1
  ELSE 2
END`;

function memberAfter([rank, joinedAtMs, id]: [number, number, string]) {
  const joinedAt = new Date(joinedAtMs);
  return or(
    gt(memberRoleRank, rank),
    and(eq(memberRoleRank, rank), gt(spaceMembers.joinedAt, joinedAt)),
    and(eq(memberRoleRank, rank), eq(spaceMembers.joinedAt, joinedAt), gt(spaceMembers.id, id)),
  );
}

export async function insertSpaceMemberWithinCap(
  db: Database,
  params: {
    spaceId: string;
    userId: string;
    memberId: string;
    role: "admin" | "member";
    now: Date;
    actorUserId: string;
  },
): Promise<
  "inserted" | "already-member" | "space-full" | "license-required" | "not-authorized" | "account-closing"
> {
  const { spaceId, userId, memberId, role, now, actorUserId } = params;
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const capClause = spaceHasMemberRoomSql(spaceId);
  const organizationLicenseClause = sql`(
    not exists (
      select 1 from ${spaces}
      where ${spaces.id} = ${spaceId}
        and ${spaces.organizationId} is not null
    )
    or exists (
      select 1
      from ${spaces} licensed_space
      inner join ${organizationMembers} license
        on license.organization_id = licensed_space.organization_id
      where licensed_space.id = ${spaceId}
        and license.user_id = ${userId}
    )
  )`;
  // An account whose deletion has begun can never sign in again, and its
  // erasure must not race a membership (and the license it pins) into being.
  const activeAccountClause = sql`exists (
    select 1 from ${users}
    where ${users.id} = ${userId}
      and ${users.deletionStartedAt} is null
  )`;
  const authorityClause =
    role === "admin"
      ? retainsSpaceAdminGrantAuthoritySql(spaceId, actorUserId)
      : retainsSpaceManagerSql(spaceId, actorUserId);

  try {
    const [insertResult] = await db.batch([
      db.insert(spaceMembers).select(
        db
          .select({
            id: sql`${memberId}`.as("id"),
            spaceId: sql`${spaceId}`.as("space_id"),
            userId: sql`${userId}`.as("user_id"),
            role: sql`${role}`.as("role"),
            joinedAt: sql`${nowSeconds}`.as("joined_at"),
          })
          .from(sql`(select 1)`)
          .where(and(capClause, organizationLicenseClause, activeAccountClause, authorityClause)),
      ),
      db
        .update(spaces)
        .set({ updatedAt: now })
        .where(
          and(
            eq(spaces.id, spaceId),
            sql`exists (select 1 from ${spaceMembers} where ${spaceMembers.id} = ${memberId})`,
          ),
        ),
    ]);

    if (getRunChanges(insertResult) > 0) return "inserted";
    const authority = await db.get<{ retained: number }>(
      sql`SELECT CASE WHEN ${authorityClause}
        THEN 1 ELSE 0 END AS retained`,
    );
    if (authority?.retained !== 1) return "not-authorized";
    const account = await db.get<{ active: number }>(
      sql`SELECT CASE WHEN ${activeAccountClause} THEN 1 ELSE 0 END AS active`,
    );
    if (account?.active !== 1) return "account-closing";

    // The insert is a conditional SELECT, so a full Space filters the row out
    // before the unique index can object: the person is already a member, but
    // the catch below never runs and the caller was told the Space is full.
    // Check membership directly rather than inferring it from a conflict that
    // only happens when there was room to attempt the write.
    const existing = await db.query.spaceMembers.findFirst({
      where: { spaceId, userId },
      columns: { id: true },
    });
    if (existing) return "already-member";

    const license = await db.get<{ eligible: number }>(
      sql`SELECT CASE WHEN ${organizationLicenseClause}
        THEN 1 ELSE 0 END AS eligible`,
    );
    return license?.eligible === 1 ? "space-full" : "license-required";
  } catch (err) {
    if (isUniqueConstraintError(err)) return "already-member";
    throw err;
  }
}

// Members are paginated independently from space metadata so a space with
// thousands of members never blows up getSpace. Keyset on (role rank,
// joinedAt, id): an offset drifted with every join and removal, so a member
// removed from one page cost the next page a member it never showed. The
// cursor carries the rank it was issued at; a role change can still move a
// member across it, which the client absorbs (`keepLastCopyPerId`).
export async function listSpaceMembersImpl({
  data,
  context: { user, db },
}: {
  data: v.InferOutput<typeof listMembersSchema>;
  context: AuthFnContext;
}) {
  await assertSpaceCapability(db, data.spaceId, user.id, "canView");

  const cursor = data.cursor ? decodeTupleCursor(data.cursor, ["number", "number", "string"]) : null;
  if (data.cursor && !cursor) throw Errors.VALIDATION("Invalid member cursor");

  const rows = await db
    .select({
      id: spaceMembers.id,
      userId: spaceMembers.userId,
      role: spaceRoleSql,
      rank: memberRoleRank,
      joinedAt: spaceMembers.joinedAt,
      userName: users.name,
      userImage: users.image,
    })
    .from(spaceMembers)
    .innerJoin(spaces, eq(spaces.id, spaceMembers.spaceId))
    .innerJoin(users, eq(spaceMembers.userId, users.id))
    .where(and(eq(spaceMembers.spaceId, data.spaceId), cursor ? memberAfter(cursor) : undefined))
    .orderBy(memberRoleRank, asc(spaceMembers.joinedAt), asc(spaceMembers.id))
    .limit(data.limit + 1);

  const hasMore = rows.length > data.limit;
  const page = hasMore ? rows.slice(0, data.limit) : rows;

  // Expose only display fields. A member's billing plan is not other members'
  // (or even space admins') business, and the internal system role must never
  // be surfaced here.
  const members = page.map((m) => ({
    id: m.id,
    userId: m.userId,
    role: m.role,
    joinedAt: m.joinedAt,
    user: {
      id: m.userId,
      name: m.userName,
      image: m.userImage,
    },
  }));

  // Caller identity/role intentionally not returned here — the detail page
  // already gets viewerId + role from getSpace, and the client derives its
  // permission checks from those. Don't re-surface them per page.
  const last = page.at(-1);
  return {
    members,
    nextCursor: hasMore && last
      ? encodeTupleCursor([last.rank, last.joinedAt.getTime(), last.id])
      : undefined,
  };
}

export async function addMemberByEmailImpl({
  data,
  context: { user, env, db },
}: {
  data: v.InferOutput<typeof addMemberByEmailSchema>;
  context: AuthFnContext;
}) {
  // H3: use the same rate-limit key as the byId path so both share one budget
  await enforceRateLimit(env, `space:addMember:${user.id}`);

  // Check caller is admin/owner and grab the space owner (for the member cap)
  // in one query — assertSpaceRole already proves the space exists via FK cascade.
  const access = await assertSpaceCapability(db, data.spaceId, user.id, "canManageMembers");

  if (data.role === "admin" && !access.capabilities.canGrantAdmins) {
    throw Errors.FORBIDDEN();
  }

  // The conditional insert below handles both the cap and existing members
  // atomically, against the plan funding the Space as it runs. A count
  // pre-check would reject an existing member when full.
  // Whether an address has an account is not a secret: email sign-in already
  // tells anyone which step an address needs. Say so plainly.
  const normalized = normalizeEmail(data.email);
  const noAccount = () => new AppError(
    "NOT_FOUND",
    "No Orb Meet account uses this email. Share the Space's invite link with them instead.",
    404,
  );
  // An account being deleted is, to everyone else, already gone.
  const targetUser = await db.query.users.findFirst({
    where: { normalizedEmail: normalized, deletionStartedAt: { isNull: true } },
    columns: { id: true, name: true },
  });
  if (!targetUser) throw noAccount();

  const result = await insertSpaceMemberWithinCap(db, {
    spaceId: data.spaceId,
    userId: targetUser.id,
    memberId: generateId("MEMBER"),
    // addMemberByEmailSchema is .optional().default("member"), so data.role is
    // always present here — no fallback needed.
    role: data.role,
    now: new Date(),
    actorUserId: user.id,
  });

  if (result === "space-full") {
    const memberCap = await resolveCurrentSpaceMemberCap(db, data.spaceId);
    throw Errors.PLAN_LIMIT_REACHED(
      memberCap === null
        ? "This space cannot take another member right now"
        : `This space has reached its ${memberCap}-member limit`,
    );
  }
  if (result === "license-required") {
    throw Errors.VALIDATION(
      "This person needs an Organization license before they can be added to this Space.",
    );
  }
  if (result === "not-authorized") {
    throw Errors.FORBIDDEN("Your Space role changed before the member was added.");
  }
  if (result === "account-closing") throw noAccount();

  if (result === "inserted") {
    await recordSpaceAuditEvent(db, {
      spaceId: data.spaceId,
      actorUserId: user.id,
      action: "member_added",
      targetUserId: targetUser.id,
      metadata: { role: data.role, via: "email" },
    });
  }

  // M2: signal whether the user was already a member so the UI can show the
  // right confirmation message instead of always saying "Member added."
  return { success: true, alreadyMember: result === "already-member" };
}

export async function removeMemberImpl({
  data,
  context: { user, env, db },
}: {
  data: v.InferOutput<typeof removeMemberSchema>;
  context: AuthFnContext;
}) {
  await enforceRateLimit(env, `space:removeMember:${user.id}`);

  // Removing yourself isn't a "remove" — it's a leave. Reject early with a clear
  // message rather than collapsing it into a generic FORBIDDEN.
  if (data.userId === user.id) {
    throw Errors.VALIDATION("Use Leave to remove yourself from a space.");
  }

  const access = await assertSpaceCapability(db, data.spaceId, user.id, "canManageMembers");

  // Look up the target member's role
  const targetMembership = await findSpaceMembership(db, data.spaceId, data.userId);
  if (!targetMembership) throw Errors.NOT_FOUND("Member");

  if (
    targetMembership.role === "owner" ||
    (targetMembership.role === "admin" && !access.capabilities.canGrantAdmins)
  ) {
    throw Errors.FORBIDDEN();
  }

  // evictUserFromSpaceMeetings is the single source of the membership delete —
  // it removes the row atomically with any live meeting-connection cleanup.
  const removed = await evictUserFromSpaceMeetings(db, env, data.spaceId, data.userId, {
    authorizedByUserId: user.id,
    removableRoles: access.capabilities.canGrantAdmins ? SPACE_MEMBERSHIP_ROLES : ["member"],
  });
  if (!removed) {
    throw Errors.VALIDATION("This member's role changed before removal completed. Please retry.");
  }

  await db.update(spaces).set({ updatedAt: new Date() }).where(eq(spaces.id, data.spaceId));

  await recordSpaceAuditEvent(db, {
    spaceId: data.spaceId,
    actorUserId: user.id,
    action: "member_removed",
    targetUserId: data.userId,
    metadata: { role: targetMembership.role },
  });

  return { success: true };
}

// F2: promote or demote a member between "admin" and "member"
export async function updateMemberRoleImpl({
  data,
  context: { user, env, db },
}: {
  data: v.InferOutput<typeof updateMemberRoleSchema>;
  context: AuthFnContext;
}) {
  await enforceRateLimit(env, `space:updateRole:${user.id}`);

  // An owner can't change their own role here (ownership moves via transfer).
  // Reject early with a clear message instead of the generic owner-row FORBIDDEN.
  if (data.userId === user.id) {
    throw Errors.VALIDATION("You can't change your own role.");
  }

  await assertSpaceCapability(db, data.spaceId, user.id, "canGrantAdmins");

  const targetMembership = await findSpaceMembership(db, data.spaceId, data.userId);
  if (!targetMembership) throw Errors.NOT_FOUND("Member");

  // The owner's admin membership is not changed here: ownership moves only by
  // transfer, and data.role can only be "admin" or "member".
  if (targetMembership.role === "owner") throw Errors.FORBIDDEN();

  const now = new Date();
  const roleUpdateResult = await db
    .update(spaceMembers)
    .set({ role: data.role })
    .where(
      and(
        eq(spaceMembers.spaceId, data.spaceId),
        eq(spaceMembers.userId, data.userId),
        sql`not ${isSpaceOwnerMembershipSql}`,
        retainsSpaceAdminGrantAuthoritySql(data.spaceId, user.id),
      ),
    );
  if (getRunChanges(roleUpdateResult) === 0) {
    throw Errors.VALIDATION(
      "This member's role changed before the update completed. Please retry.",
    );
  }

  await db.update(spaces).set({ updatedAt: now }).where(eq(spaces.id, data.spaceId));
  await refreshSpaceAuthorityInOpenMeetings(db, env, data.userId, data.spaceId, "space_role_changed");

  await recordSpaceAuditEvent(db, {
    spaceId: data.spaceId,
    actorUserId: user.id,
    action: "role_changed",
    targetUserId: data.userId,
    metadata: { from: targetMembership.role, to: data.role },
  });

  return { success: true };
}

/**
 * Atomically move ownership of a space from `fromUserId` to `toUserId`.
 *
 * Ownership is one column, `spaces.owner_user_id`, so the transfer is a single
 * compare-and-swap on it. The recipient's membership is raised to admin in the
 * same batch, only once the swap has landed; the previous owner keeps their
 * admin membership. Returns false, changing nothing, when a concurrent transfer
 * moved ownership first, the recipient left, or their plan no longer fits.
 */
export async function applyOwnershipTransfer(
  db: Database,
  params: {
    spaceId: string;
    fromUserId: string;
    toUserId: string;
    now: Date;
    // The recipient becomes the new owner, so the space must fit *their* plan: it
    // counts toward their owned-space quota and its member count must be within
    // their per-space cap. null means unlimited. These gates are evaluated inside
    // the batch so a concurrent space-create or member-join by the recipient can't
    // slip the transfer past their limits after the handler's pre-check.
    recipientMaxSpaces: number | null;
    recipientMaxMembers: number | null;
  },
): Promise<boolean> {
  const { spaceId, fromUserId, toUserId, now, recipientMaxSpaces, recipientMaxMembers } = params;

  const targetStillMember = sql`EXISTS (
    SELECT 1 FROM ${spaceMembers}
    WHERE ${spaceMembers.spaceId} = ${spaceId} AND ${spaceMembers.userId} = ${toUserId}
  )`;

  // Recipient plan gates. The recipient does not yet own this space (the spaces
  // row still points at fromUserId until the swap lands), so the owned-space
  // count must have room for one more (`< max`); the member count is unchanged by
  // a transfer, so it only has to already fit (`<= max`).
  const recipientGates: SQL[] = [];
  // Re-read the recipient's plan inside the transaction. Literal caps below
  // retain clear handler errors and protect count races; this gate additionally
  // closes a billing downgrade between that read and the ownership batch.
  recipientGates.push(sql`exists (
    select 1 from ${users}
    where ${users.id} = ${toUserId}
      and ${users.deletionStartedAt} is null
      and (
        ${users.plan} = 'organization'
        or (
          ${users.plan} = 'pro'
          and (
            select count(*) from ${spaceMembers}
            where ${spaceMembers.spaceId} = ${spaceId}
          ) <= 200
        )
        or (
          ${users.plan} = 'free'
          and ${activeOwnedSharedSpaceCountSql(toUserId)} < 1
          and (
            select count(*) from ${spaceMembers}
            where ${spaceMembers.spaceId} = ${spaceId}
          ) <= 25
        )
      )
  )`);
  if (recipientMaxSpaces !== null) {
    // The same owned-space predicate createSpace gates on: the personal space
    // and org spaces don't consume the quota.
    recipientGates.push(sql`${activeOwnedSharedSpaceCountSql(toUserId)} < ${recipientMaxSpaces}`);
  }
  if (recipientMaxMembers !== null) {
    recipientGates.push(
      sql`(SELECT count(*) FROM ${spaceMembers} WHERE ${spaceMembers.spaceId} = ${spaceId}) <= ${recipientMaxMembers}`,
    );
  }

  const [ownershipResult] = await db.batch([
    db
      .update(spaces)
      .set({ ownerUserId: toUserId, updatedAt: now })
      .where(
        and(
          eq(spaces.id, spaceId),
          eq(spaces.ownerUserId, fromUserId),
          targetStillMember,
          ...recipientGates,
        ),
      ),
    db
      .update(spaceMembers)
      .set({ role: "admin" })
      .where(
        and(
          eq(spaceMembers.spaceId, spaceId),
          eq(spaceMembers.userId, toUserId),
          sql`EXISTS (
            SELECT 1 FROM ${spaces}
            WHERE ${spaces.id} = ${spaceId} AND ${spaces.ownerUserId} = ${toUserId}
          )`,
        ),
      ),
  ]);
  return getRunChanges(ownershipResult) > 0;
}

// F1: transfer ownership to another member; caller becomes admin
export async function transferOwnershipImpl({
  data,
  context: { user, env, db },
}: {
  data: v.InferOutput<typeof transferOwnershipSchema>;
  context: AuthFnContext;
}) {
  await enforceRateLimit(env, `space:transferOwnership:${user.id}`);

  // Transferring to yourself would be a no-op swap; say so plainly.
  if (data.userId === user.id) {
    throw Errors.VALIDATION("You already own this space.");
  }

  await assertSpaceCapability(db, data.spaceId, user.id, "canTransferOwnership");
  const callerMembership = await findSpaceMembership(db, data.spaceId, user.id);
  if (callerMembership?.role !== "owner") {
    throw Errors.FORBIDDEN("Only the space's owner can transfer ownership.");
  }

  const targetMembership = await findSpaceMembership(db, data.spaceId, data.userId);
  if (!targetMembership) throw Errors.NOT_FOUND("Member");

  // The recipient becomes the owner, so the space has to fit their plan. For an org
  // space the caps come from the org plan (and it doesn't count toward a personal
  // owned-space quota); for a personal space, from the recipient's own plan. Pre-check
  // for clear error messages; applyOwnershipTransfer re-checks atomically to close
  // the race against a concurrent space-create / member-join by the recipient.
  let recipientMaxSpaces: number | null;
  let recipientMaxMembers: number | null;
  const recipientLimits = await resolveUserPlanLimits(db, data.userId);
  recipientMaxSpaces = recipientLimits.maxSpaces;
  recipientMaxMembers = recipientLimits.maxMembersPerSpace;

  if (recipientMaxSpaces !== null) {
    const owned = await db.get<{ count: number }>(
      sql`select ${activeOwnedSharedSpaceCountSql(data.userId)} as count`,
    );
    if ((owned?.count ?? 0) >= recipientMaxSpaces) {
      throw Errors.PLAN_LIMIT_REACHED(
        `This member can own at most ${recipientMaxSpaces} space(s) on their plan`,
      );
    }
  }
  if (recipientMaxMembers !== null) {
    const [{ value: memberCount } = { value: 0 }] = await db
      .select({ value: count() })
      .from(spaceMembers)
      .where(eq(spaceMembers.spaceId, data.spaceId));
    if (memberCount > recipientMaxMembers) {
      throw Errors.PLAN_LIMIT_REACHED(
        `This space has more members than the new owner's plan allows (${recipientMaxMembers})`,
      );
    }
  }

  const transferred = await applyOwnershipTransfer(db, {
    spaceId: data.spaceId,
    fromUserId: user.id,
    toUserId: data.userId,
    now: new Date(),
    recipientMaxSpaces,
    recipientMaxMembers,
  });
  if (!transferred) {
    throw Errors.VALIDATION("Ownership changed before this transfer completed. Please retry.");
  }
  for (const userId of [user.id, data.userId]) {
    await refreshSpaceAuthorityInOpenMeetings(db, env, userId, data.spaceId, "space_role_changed");
  }

  await recordSpaceAuditEvent(db, {
    spaceId: data.spaceId,
    actorUserId: user.id,
    action: "ownership_transferred",
    targetUserId: data.userId,
  });

  return { success: true };
}

export async function leaveSpaceImpl({
  data,
  context: { user, env, db },
}: {
  data: v.InferOutput<typeof leaveSpaceSchema>;
  context: AuthFnContext;
}) {
  await enforceRateLimit(env, `space:leave:${user.id}`);

  const membership = await findSpaceMembership(db, data.spaceId, user.id);
  if (!membership) throw Errors.NOT_FOUND("Membership");

  // Owners cannot leave — they must transfer ownership or delete the space
  if (membership.role === "owner") {
    throw Errors.VALIDATION(
      "Owners cannot leave a space. Transfer ownership or delete the space instead.",
    );
  }

  // An Organization space has no owner; its admins are the only managers. If this
  // is the last one, leaving would strand the space. Surface a clear message here;
  // evictUserFromSpaceMeetings' in-write guard is what closes the concurrent race.
  if (membership.role === "admin") {
    const space = await db.query.spaces.findFirst({
      where: { id: data.spaceId },
      columns: { organizationId: true },
    });
    if (space?.organizationId) {
      const [managed] = await db
        .select({ id: spaces.id })
        .from(spaces)
        .where(and(eq(spaces.id, data.spaceId), anotherSpaceManagerRemainsSql(spaces.id, user.id)));
      if (!managed) {
        throw Errors.VALIDATION(
          "You're the last admin of this space. Add another admin, or delete the space, before leaving.",
        );
      }
    }
  }

  // evictUserFromSpaceMeetings is the single source of the membership delete.
  const left = await evictUserFromSpaceMeetings(db, env, data.spaceId, user.id);
  if (!left) {
    // The owner and last-admin cases are handled above, so a false here means a
    // concurrent change (this member was removed, or a racing last-admin left).
    throw Errors.VALIDATION(
      "Couldn't leave the space — its membership just changed. Please try again.",
    );
  }

  await db.update(spaces).set({ updatedAt: new Date() }).where(eq(spaces.id, data.spaceId));

  await recordSpaceAuditEvent(db, {
    spaceId: data.spaceId,
    actorUserId: user.id,
    action: "member_left",
    targetUserId: user.id,
    metadata: { role: membership.role },
  });

  return { success: true };
}
