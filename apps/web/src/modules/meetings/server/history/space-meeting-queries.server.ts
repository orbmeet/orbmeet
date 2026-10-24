/**
 * Server implementations behind the RPC declarations in this directory.
 * Split from the sibling RPC file so the declaration file carries no
 * DB/Drizzle imports and stays safe to include in client route graphs.
 */

import { meetingLinks, meetingSummaries, meetings, users } from "@orbmeet/db/schema";
import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import { Errors } from "@/lib/app-errors";
import { decodeKeysetCursor, encodeKeysetCursor } from "@/lib/keyset-cursor";
import { assertSpaceMembership } from "../access/access-assertions";
import { callCoordinator, userSubject } from "../runtime/client.server";
import { bucketParticipantNames, partitionArtifactsByType, selectApprovedAdmissionCounts, selectLiveConnectionCounts, selectMeetingArtifactTypes, selectParticipantDisplayNames } from "./meeting-list-enrichment";
import type { AuthFnContext } from "@/app/bootstrap/middleware";
import type { ListSpaceMeetingsInput } from "./space-meeting-queries.functions";
import type { RenameOpenMeetingInput } from "./space-meeting-queries.functions";

/**
 * List a space's meetings for any member of the space: every open one first,
 * then the ended ones, most recently ended first. Powers the Meetings tab on
 * the space detail page.
 *
 * Only the ended meetings are paginated, keyset on (endedAt desc, id desc),
 * both written once when the meeting ends. Open meetings are few — a shared
 * Space holds at most one, a personal Space one per link — so they all come
 * with the first page. A meeting that ends while someone is paging lands
 * ahead of every cursor already handed out, so it is never served twice; a
 * status-derived sort key would have moved it across the page boundary.
 */
export async function listSpaceMeetingsImpl({
  data,
  context: { user, db },
}: {
  data: ListSpaceMeetingsInput;
  context: AuthFnContext;
}) {
  // Any member can see the space's meetings (not just admins).
  const access = await assertSpaceMembership(db, data.spaceId, user.id);

  const cursor = data.cursor ? decodeKeysetCursor(data.cursor) : null;
  if (data.cursor && !cursor) throw Errors.VALIDATION("Invalid meeting cursor");

  const selectMeetings = () =>
    db
      .select({
        id: meetings.id,
        code: meetingLinks.code,
        title: meetings.title,
        status: meetings.status,
        startedAt: meetings.startedAt,
        endedAt: meetings.endedAt,
        retainUntil: meetings.retainUntil,
        startedByUserId: meetings.startedByUserId,
        starterName: users.name,
        hasSummary: meetingSummaries.id,
        // The opening of the summary, for a timeline card: enough for a few
        // lines, never the whole recap on every row.
        summaryExcerpt: sql<string | null>`substr(${meetingSummaries.summary}, 1, 360)`,
      })
      .from(meetings)
      .innerJoin(meetingLinks, eq(meetings.meetingLinkId, meetingLinks.id))
      .leftJoin(users, eq(meetings.startedByUserId, users.id))
      .leftJoin(meetingSummaries, eq(meetingSummaries.meetingId, meetings.id));

  const [open, ended] = await Promise.all([
    cursor
      ? Promise.resolve([])
      : selectMeetings()
          .where(and(eq(meetings.spaceId, data.spaceId), eq(meetings.status, "open")))
          .orderBy(desc(meetings.startedAt), desc(meetings.id)),
    selectMeetings()
      .where(
        and(
          eq(meetings.spaceId, data.spaceId),
          eq(meetings.status, "ended"),
          cursor
            ? or(
                lt(meetings.endedAt, cursor.at),
                and(eq(meetings.endedAt, cursor.at), lt(meetings.id, cursor.id)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(meetings.endedAt), desc(meetings.id))
      .limit(data.limit + 1),
  ]);

  const hasMore = ended.length > data.limit;
  const endedPage = hasMore ? ended.slice(0, data.limit) : ended;
  const lastEnded = endedPage.at(-1);
  const nextCursor = hasMore && lastEnded?.endedAt
    ? encodeKeysetCursor({ at: lastEnded.endedAt, id: lastEnded.id })
    : undefined;
  const page = [...open, ...endedPage];
  const meetingIds = page.map((m) => m.id);

  const [counts, liveCounts, participantNames, artifacts] = await Promise.all([
    meetingIds.length ? selectApprovedAdmissionCounts(db, meetingIds) : Promise.resolve([]),
    meetingIds.length ? selectLiveConnectionCounts(db, meetingIds) : Promise.resolve([]),
    meetingIds.length ? selectParticipantDisplayNames(db, meetingIds) : Promise.resolve([]),
    meetingIds.length ? selectMeetingArtifactTypes(db, meetingIds) : Promise.resolve([]),
  ]);
  const countMap = new Map(counts.map((c) => [c.meetingId, c.count]));
  const liveCountMap = new Map(liveCounts.map((c) => [c.meetingId, c.count]));
  const namesByMeeting = bucketParticipantNames(participantNames);
  const {
    whiteboardState: whiteboardStateIds,
    whiteboardPdf: whiteboardPdfIds,
    recording: recordingIds,
  } = partitionArtifactsByType(artifacts);

  return {
    meetings: page.map((m) => ({
      id: m.id,
      code: m.code,
      title: m.title,
      // From outside a meeting only the Space's owner and admins manage it.
      canManageMeeting: access.capabilities.canManage,
      status: m.status,
      startedAt: m.startedAt?.toISOString() ?? null,
      endedAt: m.endedAt?.toISOString() ?? null,
      retainUntil: m.retainUntil?.toISOString() ?? null,
      starterName: m.starterName,
      hasSummary: Boolean(m.hasSummary),
      summaryExcerpt: m.summaryExcerpt,
      hasRecording: recordingIds.has(m.id),
      hasWhiteboardState: whiteboardStateIds.has(m.id),
      hasWhiteboardPdf: whiteboardPdfIds.has(m.id),
      participantCount: countMap.get(m.id) ?? 0,
      liveParticipantCount: liveCountMap.get(m.id) ?? 0,
      participantNames: namesByMeeting.get(m.id) ?? [],
    })),
    nextCursor,
  };
}

/**
 * Meeting titles name the occurrence and stop changing once it ends. While it
 * is open the Meeting's coordinator owns the title: it decides whether the
 * caller may rename it and whether the title is still the one they saw.
 */
export async function renameOpenMeetingImpl({
  data,
  context: { user, db, env },
}: {
  data: RenameOpenMeetingInput;
  context: AuthFnContext;
}) {
  const meeting = await db.query.meetings.findFirst({
    where: { id: data.meetingId, status: "open" },
    columns: { id: true },
  });
  if (!meeting) throw Errors.NOT_FOUND("Active Meeting");
  const reply = await callCoordinator(env, {
    kind: "command",
    meetingId: meeting.id,
    command: {
      kind: "renameMeeting",
      subject: userSubject(user.id),
      title: data.title || null,
      expectedTitle: data.expectedTitle,
    },
  });
  if (reply.kind !== "title") throw Errors.INTERNAL();
  return { title: reply.title };
}
