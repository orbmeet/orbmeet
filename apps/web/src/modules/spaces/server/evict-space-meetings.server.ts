import "@tanstack/react-start/server-only";

import { spaces, spaceMembers, spaceMemberRemovals, meetingAdmissions, meetingScheduleAttendees, meetingSchedules, meetings, users } from "@orbmeet/db/schema";
import { eq, and, inArray, or, sql } from "drizzle-orm";
import type { Database } from "@orbmeet/db";

import { logError } from "@/lib/logger";
import { getRunChanges } from "@/platform/database/db-utils";
import { sendMeetingRoomRpc } from "@/platform/realtime/meeting-room-rpc.server";
import { anotherSpaceManagerRemainsSql, isSpaceOwnerMembershipSql, retainsSpaceManagerSql } from "./helpers";

/**
 * Push a Space membership change to every open meeting in `spaceId` where
 * `userId` holds a live admission. Best-effort per meeting: coordinators also
 * re-read Space authority on heartbeat.
 */
export async function notifySpaceOpenMeetings(
  db: Database,
  env: Env,
  userId: string,
  spaceId: string,
  command:
    | { kind: "revoke"; userId: string; reason: string }
    | { kind: "refreshAuthority"; userId: string; reason: string },
): Promise<void> {
  const rows = await db
    .selectDistinct({ meetingId: meetings.id })
    .from(meetingAdmissions)
    .innerJoin(meetings, eq(meetings.id, meetingAdmissions.meetingId))
    .where(and(
      eq(meetingAdmissions.subjectUserId, userId),
      inArray(meetingAdmissions.admissionStatus, ["pending", "approved"]),
      eq(meetings.status, "open"),
      eq(meetings.spaceId, spaceId),
    ));
  await Promise.all(rows.map(async ({ meetingId }) => {
    try {
      await sendMeetingRoomRpc(env, { kind: "command", meetingId, command });
    } catch (error) {
      logError(`[spaces] Could not push ${command.kind} to open meeting`, { userId, meetingId, spaceId }, error);
    }
  }));
}

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
    /**
     * An admin removing someone: recorded, so the Space's invite link no
     * longer lets them back in (`space_member_removals`). A leave passes none.
     */
    removedBy?: { userId: string; at: Date };
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

  // Written by exactly the delete's own predicate, just before it in the same
  // batch: a removal is recorded if and only if this call removes the member.
  // Gated only on the membership being gone, it was also recorded for someone
  // who had left on their own meanwhile, or by an actor no longer allowed to
  // remove anyone, and kept them out of the invite link for good.
  const recordRemoval = options.removedBy
    ? db
      .insert(spaceMemberRemovals)
      .select(
        db
          .select({
            spaceId: sql`${spaceId}`.as("space_id"),
            userId: sql`${userId}`.as("user_id"),
            removedByUserId: sql`${options.removedBy.userId}`.as("removed_by_id"),
            removedAt: sql`${Math.floor(options.removedBy.at.getTime() / 1000)}`.as("removed_at"),
          })
          .from(spaceMembers)
          .where(deletableMembership),
      )
      .onConflictDoUpdate({
        target: [spaceMemberRemovals.spaceId, spaceMemberRemovals.userId],
        set: { removedByUserId: sql`excluded.removed_by_id`, removedAt: sql`excluded.removed_at` },
      })
    : null;

  const deleteMembership = db.delete(spaceMembers).where(deletableMembership);
  const deleteResult = recordRemoval
    ? (await db.batch([recordRemoval, deleteMembership, removeScheduleAttendees]))[1]
    : (await db.batch([deleteMembership, removeScheduleAttendees]))[0];
  if (getRunChanges(deleteResult) === 0) return false;

  // The coordinator also rechecks membership on the user's next heartbeat, so
  // a revoke that fails to arrive here still lands within one interval.
  await notifySpaceOpenMeetings(db, env, userId, spaceId, {
    kind: "revoke",
    userId,
    reason: "space_membership_removed",
  });
  return true;
}
