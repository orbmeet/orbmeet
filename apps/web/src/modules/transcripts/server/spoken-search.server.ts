/**
 * Server implementation behind `spoken-search.functions.ts`, split so the
 * declaration file carries no DB imports into client route graphs.
 */
import type { Database } from "@orbmeet/db";
import { meetings, spaces, transcripts } from "@orbmeet/db/schema";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { d1UnicodeContains } from "@/platform/database/d1-unicode-like";
import { meetingHistoryAccessPredicate, myMeetingUniverse } from "@/modules/meetings/server/access/resource-access";
import type { AuthFnContext } from "@/app/bootstrap/middleware";
import type { SearchMySpokenLinesInput } from "./spoken-search.functions";

export interface SpokenLine {
  id: string;
  meetingId: string;
  meetingTitle: string | null;
  meetingStartedAt: string;
  spaceName: string | null;
  speaker: string;
  text: string;
  /** How far into the meeting the line was said, in milliseconds. */
  offsetMs: number;
}

/**
 * Lines said in the viewer's past meetings that contain the search text,
 * newest meeting first and in the order they were said within it. Driven from
 * the viewer's own meeting universe and gated by the same rule as reading a
 * transcript, so a line is found only where its meeting could be opened.
 */
export async function selectMySpokenLines(
  db: Database,
  user: { id: string },
  data: SearchMySpokenLinesInput,
): Promise<SpokenLine[]> {
  const myMeetings = myMeetingUniverse(db, user.id);
  const rows = await db
    .with(myMeetings)
    .select({
      id: transcripts.id,
      meetingId: meetings.id,
      meetingTitle: meetings.title,
      meetingStartedAt: meetings.startedAt,
      spaceName: sql<string | null>`case when ${meetings.spaceKind} = 'shared' then ${spaces.name} end`,
      speaker: transcripts.participantName,
      text: transcripts.text,
      lineStartedAt: transcripts.startedAt,
    })
    .from(myMeetings)
    .crossJoin(meetings)
    .innerJoin(transcripts, eq(transcripts.meetingId, meetings.id))
    .leftJoin(spaces, eq(meetings.spaceId, spaces.id))
    .where(
      and(
        eq(meetings.id, myMeetings.meetingId),
        eq(meetings.status, "ended"),
        data.scope === "personal" ? eq(meetings.spaceKind, "personal") : undefined,
        data.scope === "spaces" ? eq(meetings.spaceKind, "shared") : undefined,
        data.spaceId ? eq(meetings.spaceId, data.spaceId) : undefined,
        data.since ? sql`${meetings.startedAt} >= ${Math.floor(data.since / 1000)}` : undefined,
        meetingHistoryAccessPredicate(db, user.id),
        d1UnicodeContains(transcripts.text, data.search),
      ),
    )
    .orderBy(desc(meetings.startedAt), asc(transcripts.startedAt), asc(transcripts.id))
    .limit(data.limit);

  return rows.map((row) => ({
    id: row.id,
    meetingId: row.meetingId,
    meetingTitle: row.meetingTitle,
    meetingStartedAt: row.meetingStartedAt.toISOString(),
    spaceName: row.spaceName,
    speaker: row.speaker,
    text: row.text,
    offsetMs: Math.max(0, row.lineStartedAt.getTime() - row.meetingStartedAt.getTime()),
  }));
}

export async function searchMySpokenLinesImpl({
  data,
  context: { user, db },
}: {
  data: SearchMySpokenLinesInput;
  context: AuthFnContext;
}) {
  return { lines: await selectMySpokenLines(db, user, data) };
}
