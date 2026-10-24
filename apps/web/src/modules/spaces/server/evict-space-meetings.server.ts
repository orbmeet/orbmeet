import "@tanstack/react-start/server-only";

import { spaces, spaceMembers, meetingScheduleAttendees, meetingSchedules, users } from "@orbmeet/db/schema";
import { eq, and, inArray, or, sql } from "drizzle-orm";
import type { Database } from "@orbmeet/db";

import { getRunChanges } from "@/platform/database/db-utils";
import { revokeFromOpenMeetings } from "@/modules/meetings/server/runtime/revoke.server";
import { anotherSpaceManagerRemainsSql, isSpaceOwnerMembershipSql, retainsSpaceManagerSql } from "./helpers";

/**
 * Atomically remove a user's space membership, then have every open meeting
 * of the space revoke them. Used by both removeMember and leaveSpace.
 *
 * Returns false without side effects when the delete is refused: the row is the
 * space owner, or — for an Organization space, which has no owner — the last
 * remaining admin. Refusing the last admin inside the DELETE predicate keeps
 * concurrent departures/removals from stranding the space with members but nobody
 * who can invite or promote.
 */
export async function evictUserFromSpaceMeetings(
  db: Database,
  env: Env,
  spaceId: string,
  userId: string,
  options: {
    authorizedByUserId?: string;
    /**
     * The roles this actor is allowed to remove. `removeMember` reads the
     * target's role and refuses an admin unless the actor may grant admins —
     * but that read is a separate statement from the DELETE, so a promotion
     * committing in between let an actor without that capability remove a
     * brand-new admin. Restating the check as a predicate makes the check and
     * the delete observe the same row.
     */
    removableRoles?: readonly ("admin" | "member")[];
  } = {},
): Promise<boolean> {
  // Never delete the space owner, nor the final admin of an Organization space
  // (personal spaces always keep their owner, so they're exempt). The last-admin
  // check runs inside the DELETE so two admins leaving/removed at once can't both
  // pass a read-then-write check and drop the space to zero managers.
  const deletableMembership = and(
    eq(spaceMembers.spaceId, spaceId),
    eq(spaceMembers.userId, userId),
    sql`not ${isSpaceOwnerMembershipSql}`,
    sql`(
      ${spaceMembers.role} <> 'admin'
      or exists (
        select 1 from ${spaces}
        where ${spaces.id} = ${spaceId} and ${spaces.organizationId} is null
      )
      or ${anotherSpaceManagerRemainsSql(spaceId, userId)}
    )`,
    options.removableRoles ? inArray(spaceMembers.role, [...options.removableRoles]) : undefined,
    options.authorizedByUserId
      ? retainsSpaceManagerSql(spaceId, options.authorizedByUserId)
      : undefined,
  );

  // Gated on the membership being gone, so it no-ops if the delete was refused
  // (owner / last admin) or the user was concurrently re-added.
  const membershipGone = sql`not exists (
    select 1 from ${spaceMembers}
    where ${spaceMembers.spaceId} = ${spaceId} and ${spaceMembers.userId} = ${userId}
  )`;
  const removeScheduleAttendees = db
    .delete(meetingScheduleAttendees)
    .where(and(
      membershipGone,
      or(
        eq(meetingScheduleAttendees.userId, userId),
        sql`${meetingScheduleAttendees.normalizedEmail} = (
          select ${users.normalizedEmail} from ${users} where ${users.id} = ${userId}
        )`,
      ),
      sql`exists (
        select 1 from ${meetingSchedules}
        where ${meetingSchedules.id} = ${meetingScheduleAttendees.scheduleId}
          and ${meetingSchedules.spaceId} = ${spaceId}
      )`,
    ));

  const [deleteResult] = await db.batch([
      db.delete(spaceMembers).where(deletableMembership),
      removeScheduleAttendees,
  ]);
  if (getRunChanges(deleteResult) === 0) return false;

  // The coordinator also rechecks membership on the user's next heartbeat, so
  // a revoke that fails to arrive here still lands within one interval.
  await revokeFromOpenMeetings(db, env, userId, "space_membership_removed", { spaceId });
  return true;
}
