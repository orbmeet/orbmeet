import type { Database } from "@orbmeet/db";
import { meetingWhiteboards, whiteboardRevisions, whiteboards } from "@orbmeet/db/schema";
import { asc, eq, sql } from "drizzle-orm";

import { logError } from "@/lib/logger";
import { readStoredSnapshot } from "@/modules/whiteboards/server/sync-commands.server";
import { joinBoardOutlines, outlineFromSnapshot } from "./board-outline";

/**
 * How many bytes of captured snapshots one summary reads. Well under the
 * export's budget: the summary needs words, and a board over this is read
 * without its later captures rather than at the isolate's expense.
 */
const SUMMARY_SNAPSHOT_BUDGET_BYTES = 4 * 1024 * 1024;

/**
 * The boards the meeting presented, as words a summary can read: one line a
 * page. Empty when nothing was captured or the captures cannot be read — a
 * summary of what was said is still worth writing without them.
 */
export async function boardOutlineForMeeting(db: Database, env: Env, meetingId: string): Promise<string> {
  try {
    const captured = await db
      .select({
        title: sql<string>`coalesce(${meetingWhiteboards.titleAtEnd}, ${whiteboards.title}, 'Whiteboard')`,
        r2Key: whiteboardRevisions.snapshotR2Key,
        snapshotSize: whiteboardRevisions.snapshotSize,
      })
      .from(meetingWhiteboards)
      .innerJoin(whiteboards, eq(whiteboards.id, meetingWhiteboards.whiteboardId))
      .innerJoin(whiteboardRevisions, eq(whiteboardRevisions.id, meetingWhiteboards.capturedRevisionId))
      .where(eq(meetingWhiteboards.meetingId, meetingId))
      .orderBy(asc(meetingWhiteboards.attachedAt), asc(meetingWhiteboards.id));
    let remaining = SUMMARY_SNAPSHOT_BUDGET_BYTES;
    const lines: string[] = [];
    for (const board of captured) {
      if (board.snapshotSize > remaining) break;
      remaining -= board.snapshotSize;
      const snapshot = await readStoredSnapshot(env, board.r2Key);
      if (snapshot) lines.push(...outlineFromSnapshot(snapshot, board.title));
    }
    return joinBoardOutlines(lines);
  } catch (error) {
    logError("[generateMeetingSummary] could not read the meeting's boards:", error);
    return "";
  }
}
