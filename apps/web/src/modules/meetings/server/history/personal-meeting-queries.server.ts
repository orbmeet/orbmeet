/**
 * Server implementations behind the RPC declarations in this directory.
 * Split from the sibling RPC file so the declaration file carries no
 * DB/Drizzle imports and stays safe to include in client route graphs.
 */

import type { Database } from "@orbmeet/db";
import { meetingLinks, meetingSummaries, meetings, meetingWhiteboards, spaces, users } from "@orbmeet/db/schema";
import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import { Errors } from "@/lib/app-errors";
import { decodeKeysetCursor, encodeKeysetCursor } from "@/lib/keyset-cursor";
import { buildD1ContainsPattern } from "@orbmeet/public-api-contract/search-pattern";
import { d1UnicodeContains } from "@/platform/database/d1-unicode-like";
import { bucketParticipantNames, partitionArtifactsByType, selectApprovedAdmissionCounts, selectLiveConnectionCounts, selectMeetingArtifactTypes, selectParticipantDisplayNames } from "./meeting-list-enrichment";
import { meetingHistoryAccessPredicate, myMeetingUniverse } from "../access/resource-access";
import type { AuthFnContext } from "@/app/bootstrap/middleware";
import type { GetMyMeetingsInput } from "./personal-meeting-queries.functions";

/** The user's full Meeting library: everything they may still see, filterable. */
export async function selectMyMeetings(
  db: Database,
  user: { id: string },
  data: GetMyMeetingsInput,
) {
  const search = data.search?.trim() ?? "";
  const searchLike = search ? buildD1ContainsPattern(search) : null;

  const myMeetings = myMeetingUniverse(db, user.id);

  // The cursor carries the last row's own sort key, so a page never looks up
  // the meeting it ended on: that meeting may since have been purged, or left
  // the caller's history with a Space membership. It also reveals nothing about
  // ids outside that history.
  const cursor = data.cursor ? decodeKeysetCursor(data.cursor) : null;
  if (data.cursor && !cursor) throw Errors.VALIDATION("Invalid meeting cursor");

  const rows = await db
    .with(myMeetings)
    .select({
      id: meetings.id,
      meetingId: meetings.id,
      meetingLinkId: meetingLinks.id,
      code: meetingLinks.code,
      meetingLinkReusePolicy: meetingLinks.reusePolicy,
      title: meetings.title,
      status: meetings.status,
      startedAt: meetings.startedAt,
      endedAt: meetings.endedAt,
      retainUntil: meetings.retainUntil,
      // Whether the viewer started it: who may end a live one from the list.
      startedByMe: sql<number>`${meetings.startedByUserId} = ${user.id}`,
      // The personal space is not addressable as a space in client payloads.
      spaceId: sql<
        string | null
      >`case when ${meetings.spaceKind} = 'shared' then ${meetings.spaceId} end`,
      spaceName: sql<
        string | null
      >`case when ${meetings.spaceKind} = 'shared' then ${spaces.name} end`,
      starterName: users.name,
      hasSummary: meetingSummaries.id,
    })
    .from(myMeetings)
    // CROSS JOIN pins the join order: SQLite never reorders across it, so
    // the CTE stays the outer loop and meetings is probed by primary key.
    // A plain join here lets the planner flip back to scanning meetings.
    .crossJoin(meetings)
    .innerJoin(meetingLinks, eq(meetings.meetingLinkId, meetingLinks.id))
    .leftJoin(spaces, eq(meetings.spaceId, spaces.id))
    .leftJoin(users, eq(meetings.startedByUserId, users.id))
    .leftJoin(meetingSummaries, eq(meetingSummaries.meetingId, meetings.id))
    .where(
      and(
        eq(meetings.id, myMeetings.meetingId),
        data.status === "all" ? undefined : eq(meetings.status, data.status),
        data.scope === "personal" ? eq(meetings.spaceKind, "personal") : undefined,
        data.scope === "spaces" ? eq(meetings.spaceKind, "shared") : undefined,
        data.spaceId ? eq(meetings.spaceId, data.spaceId) : undefined,
        meetingHistoryAccessPredicate(db, user.id),
        searchLike
          ? sql`(
              ${d1UnicodeContains(sql`coalesce(${meetings.title}, ${meetingLinks.code})`, search)}
              OR ${d1UnicodeContains(users.name, search)}
              OR ${d1UnicodeContains(sql`coalesce(${meetingSummaries.summary}, '')`, search)}
              OR exists (
                select 1 from meeting_admissions admission
                where admission.meeting_id = ${meetings.id}
                  and admission.admission_status = 'approved'
                  and ${d1UnicodeContains(sql.raw("admission.display_name"), search)}
              )
            )`
          : undefined,
        data.since ? sql`${meetings.startedAt} >= ${Math.floor(data.since / 1000)}` : undefined,
        data.until ? sql`${meetings.startedAt} < ${Math.ceil(data.until / 1000)}` : undefined,
        data.person
          ? sql`exists (
              select 1 from meeting_admissions admission
              where admission.meeting_id = ${meetings.id}
                and admission.admission_status = 'approved'
                and admission.display_name = ${data.person}
            )`
          : undefined,
        data.hasSummary ? sql`${meetingSummaries.id} IS NOT NULL` : undefined,
        data.hasRecording
          ? sql`exists (
              select 1 from meeting_artifacts artifact
              where artifact.meeting_id = ${meetings.id}
                and artifact.type = 'recording'
            )`
          : undefined,
        data.hasWhiteboard
          ? sql`exists (
              select 1 from ${meetingWhiteboards} usage
              where usage.meeting_id = ${meetings.id}
            )`
          : undefined,
        cursor
          ? or(
              lt(meetings.startedAt, cursor.at),
              and(eq(meetings.startedAt, cursor.at), lt(meetings.id, cursor.id)),
            )
          : undefined,
      ),
    )
    .orderBy(desc(meetings.startedAt), desc(meetings.id))
    .limit(data.limit + 1);

  const page = rows.length > data.limit ? rows.slice(0, data.limit) : rows;
  const last = page.at(-1);
  const meetingIds = page.map((row) => row.id);

  if (meetingIds.length === 0) {
    return { meetings: [], nextCursor: undefined };
  }

  const [counts, liveCounts, artifacts, admissions] = await Promise.all([
    selectApprovedAdmissionCounts(db, meetingIds),
    selectLiveConnectionCounts(db, meetingIds),
    selectMeetingArtifactTypes(db, meetingIds),
    selectParticipantDisplayNames(db, meetingIds),
  ]);

  const countMap = new Map(counts.map((item) => [item.meetingId, item.count]));
  const liveCountMap = new Map(liveCounts.map((item) => [item.meetingId, item.count]));
  const {
    whiteboardState: whiteboardStateMeetingIds,
    whiteboardPdf: whiteboardPdfMeetingIds,
    recording: recordingMeetingIds,
  } = partitionArtifactsByType(artifacts);
  const participantNamesByMeeting = bucketParticipantNames(admissions);

  return {
    meetings: page.map((meeting) => ({
      ...meeting,
      startedByMe: Boolean(meeting.startedByMe),
      hasSummary: Boolean(meeting.hasSummary),
      hasWhiteboardState: whiteboardStateMeetingIds.has(meeting.id),
      hasWhiteboardPdf: whiteboardPdfMeetingIds.has(meeting.id),
      hasRecording: recordingMeetingIds.has(meeting.id),
      participantCount: countMap.get(meeting.id) ?? 0,
      liveParticipantCount: liveCountMap.get(meeting.id) ?? 0,
      participantNames: participantNamesByMeeting.get(meeting.id) ?? [],
      startedAt: meeting.startedAt?.toISOString() ?? null,
      endedAt: meeting.endedAt?.toISOString() ?? null,
      retainUntil: meeting.retainUntil?.toISOString() ?? null,
    })),
    nextCursor: rows.length > data.limit && last
      ? encodeKeysetCursor({ at: last.startedAt, id: last.id })
      : undefined,
  };
}

export async function getMyMeetingsImpl({
  data,
  context: { user, db },
}: {
  data: GetMyMeetingsInput;
  context: AuthFnContext;
}) {
  return selectMyMeetings(db, user, data);
}
