import type { Database } from "@orbmeet/db";
import { meetings, meetingWhiteboards, whiteboards } from "@orbmeet/db/schema";
import { and, eq, gte, inArray, isNull } from "drizzle-orm";

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
 * Name a meeting that has no title; a title someone chose is never touched.
 *
 * The boards it made go by the same name: a board made for an untitled
 * meeting was named after its date, so a week of sessions listed as one
 * repeated "Whiteboard · Oct 15, 2026". Only a board made during this meeting
 * and still called exactly that is renamed. A board someone named — even
 * "Whiteboard · Chapter 4 plan" — keeps its name, so does an older board the
 * meeting opened, and an archived board is left as it was put away.
 */
export async function nameUntitledMeeting(db: Database, meetingId: string, proposed: string): Promise<void> {
  const title = cleanGeneratedTitle(proposed);
  if (!title) return;
  const [named] = await db
    .update(meetings)
    .set({ title })
    .where(and(eq(meetings.id, meetingId), isNull(meetings.title)))
    .returning({ startedAt: meetings.startedAt });
  if (!named) return;

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
        gte(whiteboards.createdAt, named.startedAt),
        inArray(whiteboards.title, datedTitlesFor(named.startedAt)),
      ),
    );
}
