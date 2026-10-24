import type { Database } from "@orbmeet/db";
import { meetingLinks, meetings } from "@orbmeet/db/schema";
import { and, eq, isNull, sql } from "drizzle-orm";
import { withD1Retry } from "@/platform/database/db-utils";

/**
 * Remove an occurrence nobody ever joined. This is not an "end": no meeting
 * started, so deleting the provisional occurrence preserves a one-time link
 * for retry and leaves no empty history or Summary behind.
 *
 * Only the meeting's coordinator calls this, and only once it has seen no
 * attempt join, none on the way in, and no one waiting. `first_joined_at` is
 * written once when LiveKit first reports anyone in the room and is never
 * cleared, so it also fences this delete in D1.
 */
export async function discardUnstartedMeeting(db: Database, meetingId: string): Promise<void> {
  const provisional = await db.query.meetings.findFirst({
    where: { id: meetingId },
    columns: { meetingLinkId: true, startedAt: true },
  });
  if (!provisional) return;

  await withD1Retry(
    () => db.batch([
      db
        .delete(meetings)
        .where(and(
          eq(meetings.id, meetingId),
          eq(meetings.status, "open"),
          isNull(meetings.firstJoinedAt),
        )),
      // The occurrence mint and this rollback are two halves of the same
      // one-time-link transaction. Only restore the exact spend written by
      // this occurrence, and only once the occurrence is gone.
      db
        .update(meetingLinks)
        .set({ spentAt: null, lastUsedAt: null, updatedAt: new Date() })
        .where(and(
          eq(meetingLinks.id, provisional.meetingLinkId),
          eq(meetingLinks.reusePolicy, "one_time"),
          eq(meetingLinks.spentAt, provisional.startedAt),
          sql`not exists (select 1 from ${meetings} where ${meetings.id} = ${meetingId})`,
        )),
    ]),
    { idempotent: true },
  );
}
