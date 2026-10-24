/**
 * Server implementations behind `follow-ups.functions.ts`, split so the
 * declaration file carries no DB imports into client route graphs.
 */
import type { Database } from "@orbmeet/db";
import { meetingFollowUps, meetings } from "@orbmeet/db/schema";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { Errors } from "@/lib/app-errors";
import { canAccessMeetingHistory, meetingHistoryAccessPredicate, myMeetingUniverse } from "@/modules/meetings/server/access/resource-access";
import type { AuthFnContext } from "@/app/bootstrap/middleware";
import type { ListMyOpenFollowUpsInput, SetFollowUpDoneInput } from "./follow-ups.functions";

/** How far back Home looks for follow-ups still open: older work has been settled or forgotten. */
const OPEN_FOLLOW_UP_WINDOW_DAYS = 30;

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

export async function setFollowUpDoneImpl({
  data,
  context: { user, db },
}: {
  data: SetFollowUpDoneInput;
  context: AuthFnContext;
}) {
  const followUp = await db.query.meetingFollowUps.findFirst({
    where: { id: data.followUpId },
    columns: { id: true, meetingId: true },
  });
  // A follow-up in a meeting the caller cannot open does not exist for them.
  if (!followUp || !(await canAccessMeetingHistory(db, followUp.meetingId, user.id))) {
    throw Errors.NOT_FOUND("Follow-up");
  }
  await db
    .update(meetingFollowUps)
    .set(data.done ? { doneAt: new Date(), doneByUserId: user.id } : { doneAt: null, doneByUserId: null })
    .where(eq(meetingFollowUps.id, followUp.id));
  return { id: followUp.id, done: data.done };
}

export interface OpenFollowUp extends MeetingFollowUp {
  meetingId: string;
  meetingTitle: string | null;
  meetingStartedAt: string;
}

/**
 * Follow-ups still open from the viewer's meetings of the past month — what
 * Home shows beside what just happened. Driven from the viewer's own meeting
 * universe and the history rule, so only meetings they can open contribute.
 */
export async function selectMyOpenFollowUps(
  db: Database,
  user: { id: string },
  limit: number,
  now = new Date(),
): Promise<OpenFollowUp[]> {
  const myMeetings = myMeetingUniverse(db, user.id);
  const since = Math.floor(now.getTime() / 1000) - OPEN_FOLLOW_UP_WINDOW_DAYS * 86_400;
  const rows = await db
    .with(myMeetings)
    .select({
      id: meetingFollowUps.id,
      text: meetingFollowUps.text,
      ownerName: meetingFollowUps.ownerName,
      meetingId: meetings.id,
      meetingTitle: meetings.title,
      meetingStartedAt: meetings.startedAt,
    })
    .from(myMeetings)
    .crossJoin(meetings)
    .innerJoin(meetingFollowUps, eq(meetingFollowUps.meetingId, meetings.id))
    .where(
      and(
        eq(meetings.id, myMeetings.meetingId),
        eq(meetings.status, "ended"),
        sql`${meetings.startedAt} >= ${since}`,
        isNull(meetingFollowUps.doneAt),
        meetingHistoryAccessPredicate(db, user.id),
      ),
    )
    .orderBy(desc(meetings.startedAt), asc(meetingFollowUps.position))
    .limit(limit);
  return rows.map((row) => ({ ...row, done: false, meetingStartedAt: row.meetingStartedAt.toISOString() }));
}

export async function listMyOpenFollowUpsImpl({
  data,
  context: { user, db },
}: {
  data: ListMyOpenFollowUpsInput;
  context: AuthFnContext;
}) {
  return { followUps: await selectMyOpenFollowUps(db, user, data.limit) };
}
