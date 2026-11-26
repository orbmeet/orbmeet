/**
 * Server queries for meeting follow-ups, split so declaration files carry no
 * DB imports into client route graphs.
 */
import type { Database } from "@orbmeet/db";
import { meetingFollowUps } from "@orbmeet/db/schema";
import { asc, eq } from "drizzle-orm";

export interface MeetingFollowUp {
  id: string;
  text: string;
  ownerName: string | null;
  done: boolean;
}

export async function selectMeetingFollowUps(db: Database, meetingId: string): Promise<MeetingFollowUp[]> {
  const rows = await db
    .select({ id: meetingFollowUps.id, text: meetingFollowUps.text, ownerName: meetingFollowUps.ownerName, doneAt: meetingFollowUps.doneAt })
    .from(meetingFollowUps)
    .where(eq(meetingFollowUps.meetingId, meetingId))
    .orderBy(asc(meetingFollowUps.position));
  return rows.map(({ doneAt, ...row }) => ({ ...row, done: doneAt !== null }));
}
