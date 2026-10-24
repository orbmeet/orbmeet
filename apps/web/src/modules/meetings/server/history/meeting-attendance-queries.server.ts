/**
 * Server implementations behind the RPC declarations in this directory.
 * Split from the sibling RPC file so the declaration file carries no
 * DB/Drizzle imports and stays safe to include in client route graphs.
 */

import type { Database } from "@orbmeet/db";
import { meetingAdmissions, meetingConnections } from "@orbmeet/db/schema";
import { and, asc, desc, eq, exists, gt, max, min, or, sql } from "drizzle-orm";
import type { MeetingRole } from "@/modules/meetings/contract/constants";
import { Errors } from "@/lib/app-errors";
import { assertMeetingHistoryAccess } from "../access/resource-access";
import type { AuthFnContext } from "@/app/bootstrap/middleware";
import type { MeetingAttendanceInput } from "./meeting-attendance-queries.functions";

/**
 * Attendance is an historical projection, not the admission queue. Include
 * everyone who was approved plus anyone with an actual connection record (for
 * example, an attendee revoked after joining), but never expose people who
 * merely waited for or were denied admission.
 */
export async function selectMeetingAttendance(
  db: Database,
  meetingId: string,
  userId: string,
  options: { cursor?: string; limit?: number } = {},
) {
  const meeting = await db.query.meetings.findFirst({
    where: { id: meetingId, status: "ended" },
    columns: { id: true, startedByUserId: true, spaceKind: true },
  });
  if (!meeting) throw Errors.NOT_FOUND("Meeting");

  await assertMeetingHistoryAccess(db, meeting.id, userId);

  const limit = Math.min(100, Math.max(1, options.limit ?? 100));
  const cursor = options.cursor
    ? await db.query.meetingAdmissions.findFirst({
        where: { id: options.cursor, meetingId: meeting.id },
        columns: { id: true, createdAt: true },
      })
    : undefined;
  if (options.cursor && !cursor) throw Errors.VALIDATION("Invalid attendance cursor");

  // One row per admission, however many connections it made (every rejoin
  // and page reload is one): its span runs from the first connect to the last
  // disconnect, in the role its latest connection held. Correlated subqueries
  // built with the query builder, which qualifies the outer admission column.
  const ofAdmission = eq(meetingConnections.admissionId, meetingAdmissions.id);
  const latestRole = db
    .select({ role: meetingConnections.role })
    .from(meetingConnections)
    .where(ofAdmission)
    .orderBy(desc(meetingConnections.tokenIssuedAt), desc(meetingConnections.id))
    .limit(1);
  const firstConnectedAt = db
    .select({ at: min(meetingConnections.connectedAt) })
    .from(meetingConnections)
    .where(ofAdmission);
  const lastDisconnectedAt = db
    .select({ at: max(meetingConnections.disconnectedAt) })
    .from(meetingConnections)
    .where(ofAdmission);
  const rows = await db
    .select({
      id: meetingAdmissions.id,
      displayName: meetingAdmissions.displayName,
      userId: meetingAdmissions.subjectUserId,
      cachedRole: sql<MeetingRole | null>`(${latestRole})`,
      meetingModerator: meetingAdmissions.meetingModerator,
      admittedAt: meetingAdmissions.decidedAt,
      connectedAt: sql`(${firstConnectedAt})`.mapWith(meetingConnections.connectedAt),
      disconnectedAt: sql`(${lastDisconnectedAt})`.mapWith(meetingConnections.disconnectedAt),
    })
    .from(meetingAdmissions)
    .where(
      and(
        eq(meetingAdmissions.meetingId, meeting.id),
        cursor
          ? or(
              gt(meetingAdmissions.createdAt, cursor.createdAt),
              and(
                eq(meetingAdmissions.createdAt, cursor.createdAt),
                gt(meetingAdmissions.id, cursor.id),
              ),
            )
          : undefined,
        or(
          eq(meetingAdmissions.admissionStatus, "approved"),
          exists(db.select({ id: meetingConnections.id }).from(meetingConnections).where(ofAdmission)),
        ),
      ),
    )
    .orderBy(asc(meetingAdmissions.createdAt), asc(meetingAdmissions.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  const isPersonalMeetingStarter = (participantUserId: string | null) =>
    meeting.spaceKind === "personal" &&
    participantUserId !== null &&
    participantUserId === meeting.startedByUserId;

  return {
    participants: page.map((row) => ({
      id: row.id,
      displayName: row.displayName,
      role:
        row.cachedRole ??
        (row.meetingModerator
          ? "moderator"
          : isPersonalMeetingStarter(row.userId)
            ? "host"
            : "attendee"),
      admittedAt: row.admittedAt?.toISOString() ?? null,
      connectedAt: row.connectedAt?.toISOString() ?? null,
      disconnectedAt: row.disconnectedAt?.toISOString() ?? null,
    })),
    nextCursor: hasMore ? page.at(-1)?.id : undefined,
  };
}

export async function getMeetingAttendanceImpl({
  data,
  context: { user, db },
}: {
  data: MeetingAttendanceInput;
  context: AuthFnContext;
}) {
  return selectMeetingAttendance(db, data.meetingId, user.id, { cursor: data.cursor });
}
