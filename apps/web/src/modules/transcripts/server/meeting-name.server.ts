import type { Database } from "@orbmeet/db";
import { meetings, meetingWhiteboards, whiteboards } from "@orbmeet/db/schema";
import { and, eq, gte, inArray, isNull, sql, type SQL } from "drizzle-orm";

import type { BatchStatement } from "@/platform/database/db-batching";
import { datedWhiteboardTitle } from "@/modules/whiteboards/server/documents";
import { cleanGeneratedTitle } from "./meeting-name";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Every name a board made for a meeting that began at `startedAt` could have
 * been given: its day in the zone of whoever opened it, which is the UTC day
 * or one either side of it.
 */
function datedTitlesFor(startedAt: Date): string[] {
  return [-1, 0, 1].map((days) => datedWhiteboardTitle(new Date(startedAt.getTime() + days * DAY_MS), "UTC"));
}

/**
 * Statements that name an untitled meeting and any dated boards created during
 * it, meant to run inside the summary's own atomic `db.batch` so a retry after
 * summary insertion never skips naming.
 */
export function nameUntitledMeetingStatements(
  db: Database,
  input: {
    meetingId: string;
    startedAt: Date;
    proposed: string;
    applies?: SQL;
    now?: Date;
  },
): BatchStatement[] {
  const title = cleanGeneratedTitle(input.proposed);
  if (!title) return [];
  const usedBoards = db
    .select({ id: meetingWhiteboards.whiteboardId })
    .from(meetingWhiteboards)
    .where(eq(meetingWhiteboards.meetingId, input.meetingId));
  return [
    db
      .update(meetings)
      .set({ title })
      .where(and(eq(meetings.id, input.meetingId), isNull(meetings.title), input.applies)),
    db
      .update(whiteboards)
      .set({ title, updatedAt: input.now ?? new Date() })
      .where(
        and(
          inArray(whiteboards.id, usedBoards),
          eq(whiteboards.status, "active"),
          gte(whiteboards.createdAt, input.startedAt),
          inArray(whiteboards.title, datedTitlesFor(input.startedAt)),
          sql`exists (select 1 from ${meetings} where ${meetings.id} = ${input.meetingId} and ${meetings.title} = ${title})`,
          input.applies,
        ),
      ),
  ];
}
