import type { Database } from "@orbmeet/db";
import {
  meetings,
  meetingWhiteboards,
  meetingWhiteboardSurfaces,
} from "@orbmeet/db/schema";
import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import { generateId } from "@/lib/ids";
import type { MeetingEndReason } from "@orbmeet/domain-model";

/**
 * A meeting's end in D1, in two writes, both issued by the meeting's room:
 *
 * 1. {@link beginMeetingCloseStatement} rides in the projection batch of the
 *    commit that ended the meeting, freezing what its capture reads.
 * 2. {@link finalizeMeetingEnd} is the room's `meeting.finalize` effect: it
 *    flips the meeting to ended, recording why in the same statement.
 */

/** Freeze selection and reserve one capture identity in the ending command's transaction. */
export function beginMeetingCloseStatement(db: Database, meetingId: string, now: Date) {
  return db.update(meetings).set({
    closingAt: now,
    closingCommandId: generateId("SYNC_COMMAND"),
    closingWhiteboardId: sql`(select ${meetingWhiteboards.id} from ${meetingWhiteboards}
      where ${meetingWhiteboards.meetingId} = ${meetingId}
        and ${meetingWhiteboards.focusedAt} is not null limit 1)`,
  }).where(and(eq(meetings.id, meetingId), eq(meetings.status, "open"), isNull(meetings.closingAt)));
}

/**
 * End an open meeting and record why, freezing what its history needs in the
 * same transaction. The presented Whiteboard's pin is the room's own effect,
 * so an unreachable sync server never holds the end up. Idempotent: resolves
 * false when the meeting was not open.
 */
export async function finalizeMeetingEnd(
  db: Database,
  { meetingId, reason, now, summaryOwed }: { meetingId: string; reason: MeetingEndReason; now: Date; summaryOwed: boolean },
): Promise<boolean> {
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const meetingFilter = and(eq(meetings.id, meetingId), eq(meetings.status, "open"));
  const openMeeting = sql`(select ${meetings.id} from ${meetings} where ${meetingFilter})`;

  // The status flip is deliberately last: it moves the row out of
  // `meetingFilter`, so every statement that selects through that filter has
  // to run ahead of it.
  const [, finalizedRows] = await db.batch([
    db.delete(meetingWhiteboardSurfaces).where(sql`${meetingWhiteboardSurfaces.meetingId} in ${openMeeting}`),
    db
      .update(meetings)
      .set({
        status: "ended",
        endReason: reason,
        endedAt: clampedToStart(nowSeconds),
        updatedAt: sql`max(${meetings.updatedAt}, ${clampedToStart(nowSeconds)})`,
        activeEgressId: null,
        activeStreamEgressId: null,
        retainUntil: null,
        summaryStatus: summaryOwed ? "pending" : null,
      })
      .where(meetingFilter)
      .returning({ id: meetings.id }),
  ]);
  return finalizedRows.length > 0;
}

/**
 * A timestamp that can never precede the meeting's own start. Schema checks
 * require `ended_at >= started_at` and `updated_at >= started_at`, and
 * `started_at` was stamped by another Worker's clock: a skew of milliseconds
 * at second granularity would otherwise fail the whole batch, leaving the
 * meeting open.
 */
function clampedToStart(epochSeconds: number): SQL {
  return sql`max(${meetings.startedAt}, ${epochSeconds})`;
}
