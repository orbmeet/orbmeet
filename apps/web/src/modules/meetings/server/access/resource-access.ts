import type { Database } from "@orbmeet/db";
import {
  meetingAdmissions,
  meetingConnections,
  meetings,
  spaceMembers,
  spaces,
} from "@orbmeet/db/schema";
import { Errors } from "@/lib/app-errors";
import { and, eq, exists, isNotNull, isNull, or } from "drizzle-orm";
import { findEffectiveSpaceRole } from "@/modules/spaces/server/helpers";
import { connectionIsPresent } from "@/modules/meetings/server/connection/state";

/**
 * Every meeting a user may find in their library, as a CTE: `my_meetings`,
 * one column, `meeting_id`.
 *
 * The user's meeting universe, resolved from their own indexes
 * (admissions by subject_user_id, meetings by started_by_user_id). Driving the
 * listing from this set keeps rows read proportional to the user's own
 * history; expressing membership as an OR across the admissions join made
 * SQLite scan the entire meetings table per page view. UNION also dedupes,
 * so no GROUP BY is needed downstream (all remaining joins are 1:1).
 */
export function myMeetingUniverse(db: Database, userId: string) {
  return db.$with("my_meetings").as(
    db
      .select({ meetingId: meetingAdmissions.meetingId })
      .from(meetingAdmissions)
      .where(
        and(
          eq(meetingAdmissions.subjectUserId, userId),
          eq(meetingAdmissions.admissionStatus, "approved"),
        ),
      )
      .union(
        db
          .select({ meetingId: meetings.id })
          .from(meetings)
          .where(eq(meetings.startedByUserId, userId)),
      )
      .union(
        db
          .select({ meetingId: meetings.id })
          .from(spaceMembers)
          .innerJoin(meetings, eq(meetings.spaceId, spaceMembers.spaceId))
          .where(and(eq(spaceMembers.userId, userId), eq(meetings.spaceKind, "shared"))),
      ),
  );
}

/**
 * Correlated SQL form of the ended-Meeting access policy. Queries that list or
 * resolve Meetings must use this predicate so discovery cannot disagree with
 * direct resource access.
 *
 * The policy is per Space kind, because "who legitimately attended" is answered
 * by a different source of truth in each:
 *
 * - Shared Space: membership is the entry boundary (`assertSharedSpaceMembership`
 *   gates `joinMeeting` and is re-checked after token issuance), so every
 *   approved admission belongs to someone who was a member at the time. Current
 *   membership therefore already covers everyone entitled to the history, and an
 *   admission fallback would only ever admit people whose membership has since
 *   been removed — which is the access removal exists to end. Eviction revokes
 *   admissions only for Meetings that are still `open`, so relying on admission
 *   state here would have left recordings, transcripts and summaries readable by
 *   former members indefinitely.
 * - Personal Space: the owner is its only member, so attendance is the only
 *   record that an invited user was there, and it is the whole policy for
 *   them. Attending means reaching the room: an approved admission with at
 *   least one connection that went live. Approval alone is not enough — in an
 *   open Meeting it is granted the moment someone asks to join, before their
 *   connection reaches the room, so it would hand the whole history to anyone
 *   who clicked Join and left.
 */
export function meetingHistoryAccessPredicate(db: Database, userId: string) {
  const isCurrentSpaceMember = exists(
    db
      .select({ id: spaceMembers.id })
      .from(spaceMembers)
      .innerJoin(
        spaces,
        and(eq(spaces.id, spaceMembers.spaceId), isNull(spaces.archivedAt)),
      )
      .where(
        and(
          eq(spaceMembers.spaceId, meetings.spaceId),
          eq(spaceMembers.userId, userId),
        ),
      ),
  );
  const attended = exists(
    db
      .select({ id: meetingAdmissions.id })
      .from(meetingAdmissions)
      .innerJoin(
        meetingConnections,
        and(
          eq(meetingConnections.admissionId, meetingAdmissions.id),
          eq(meetingConnections.meetingId, meetingAdmissions.meetingId),
          isNotNull(meetingConnections.connectedAt),
        ),
      )
      .where(
        and(
          eq(meetingAdmissions.meetingId, meetings.id),
          eq(meetingAdmissions.subjectUserId, userId),
          eq(meetingAdmissions.admissionStatus, "approved"),
        ),
      ),
  );

  return or(
    and(eq(meetings.spaceKind, "shared"), isCurrentSpaceMember),
    and(
      eq(meetings.spaceKind, "personal"),
      or(isCurrentSpaceMember, attended),
    ),
  );
}

/**
 * The single authorization policy for an ended Meeting and every user-facing
 * resource derived from it: Transcript, Summary, recording, captured Whiteboard,
 * and exported Whiteboard PDF.
 */
export async function canAccessMeetingHistory(
  db: Database,
  meetingId: string,
  userId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: meetings.id })
    .from(meetings)
    .where(
      and(
        eq(meetings.id, meetingId),
        meetingHistoryAccessPredicate(db, userId),
      ),
    )
    .limit(1);

  return Boolean(row);
}

export async function assertMeetingHistoryAccess(
  db: Database,
  meetingId: string,
  userId: string,
): Promise<void> {
  if (!(await canAccessMeetingHistory(db, meetingId, userId))) {
    throw Errors.FORBIDDEN();
  }
}

/** Access to mutable Meeting resources while the Meeting is open. */
export async function canAccessActiveMeeting(
  db: Database,
  meetingId: string,
  userId: string,
): Promise<boolean> {
  const [row] = await db
    .select({
      spaceId: meetings.spaceId,
      spaceKind: meetings.spaceKind,
      connectionId: meetingConnections.id,
    })
    .from(meetings)
    .leftJoin(
      meetingConnections,
      and(
        eq(meetingConnections.meetingId, meetingId),
        eq(meetingConnections.userId, userId),
        connectionIsPresent(),
      ),
    )
    .where(and(eq(meetings.id, meetingId), eq(meetings.status, "open")))
    .limit(1);

  if (!row) return false;
  const role = await findEffectiveSpaceRole(db, row.spaceId, userId);
  // A live connection always grants access to the meeting it belongs to; the
  // personal-space owner (its only member) manages their meetings directly.
  if (row.spaceKind === "personal") {
    return role !== null || Boolean(row.connectionId);
  }
  if (!role) return false;
  return Boolean(row.connectionId) || role === "owner" || role === "admin";
}
