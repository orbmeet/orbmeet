import type { Database } from "@orbmeet/db";
import { meetings, meetingWhiteboards, whiteboards } from "@orbmeet/db/schema";
import { and, eq, inArray, isNull, like } from "drizzle-orm";

import { cleanGeneratedTitle } from "./meeting-name";

/** The name a board made for an untitled meeting is given until someone names it. */
const DATED_BOARD_TITLE = "Whiteboard · %";

/**
 * Name a meeting that has no title; a title someone chose is never touched.
 *
 * The boards it made go by the same name: a board made for an untitled
 * meeting was named after its date, so a week of sessions listed as one
 * repeated "Whiteboard · Oct 15". A board someone renamed keeps its name,
 * and an archived board is left as it was put away.
 */
export async function nameUntitledMeeting(db: Database, meetingId: string, proposed: string): Promise<void> {
  const title = cleanGeneratedTitle(proposed);
  if (!title) return;
  const named = await db
    .update(meetings)
    .set({ title })
    .where(and(eq(meetings.id, meetingId), isNull(meetings.title)))
    .returning({ id: meetings.id });
  if (named.length === 0) return;

  const usedBoards = db
    .select({ id: meetingWhiteboards.whiteboardId })
    .from(meetingWhiteboards)
    .where(eq(meetingWhiteboards.meetingId, meetingId));
  await db
    .update(whiteboards)
    .set({ title, updatedAt: new Date() })
    .where(
      and(
        inArray(whiteboards.id, usedBoards),
        eq(whiteboards.status, "active"),
        like(whiteboards.title, DATED_BOARD_TITLE),
      ),
    );
}
