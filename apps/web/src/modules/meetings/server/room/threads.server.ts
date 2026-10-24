import type {
  Thread,
  ThreadLatestMeeting,
  ThreadOpenMeeting,
} from "@/modules/meetings/contract/threads";

/**
 * Server implementations behind the RPC declarations in this directory.
 * Split from the sibling RPC file so the declaration file carries no
 * DB/Drizzle imports and stays safe to include in client route graphs.
 */

import type { Database } from "@orbmeet/db";
import { meetingConnections, meetingLinks, meetingSummaries, meetings } from "@orbmeet/db/schema";
import { and, count, eq, exists, inArray, sql } from "drizzle-orm";
import { boundedStatements } from "@/platform/database/db-batching";
import { selectDashboardMeetingLinks, type DashboardUser } from "../history/dashboard-queries";
import { selectSpacesForUser } from "@/modules/spaces/server/helpers";
import type { AuthFnContext } from "@/app/bootstrap/middleware";
import { connectionIsPresent, connectionIsUnfinished } from "@/modules/meetings/server/connection/state";

interface OpenMeetingRow {
  meetingId: string;
  meetingLinkId: string;
  spaceId: string | null;
  code: string;
  title: string | null;
  startedAt: Date | null;
}

/** Open meetings on the user's current personal links / spaces, plus any they are connected to. */
async function selectOpenMeetings(
  db: Database,
  userId: string,
  linkIds: string[],
  spaceIds: string[],
): Promise<Map<string, OpenMeetingRow>> {
  // Built inside the function, not at module scope. This reads Drizzle schema
  // exports (meetings.id, meetingLinks.code, …), which the browser build stubs.
  // A module-scope literal would read them at client module-eval time and trip
  // the import-protection stub (`importProtection` in vite.config.ts).
  const openMeetingSelection = {
    meetingId: meetings.id,
    meetingLinkId: meetings.meetingLinkId,
    spaceId: meetings.spaceId,
    code: meetingLinks.code,
    title: meetings.title,
    startedAt: meetings.startedAt,
  };

  const byMeetingId = new Map<string, OpenMeetingRow>();

  const collect = (rows: OpenMeetingRow[]) => {
    for (const row of rows) byMeetingId.set(row.meetingId, row);
  };

  const openOn = (column: typeof meetings.meetingLinkId | typeof meetings.spaceId, ids: string[]) =>
    boundedStatements(ids, (chunk) =>
      db
        .select(openMeetingSelection)
        .from(meetings)
        .innerJoin(meetingLinks, eq(meetings.meetingLinkId, meetingLinks.id))
        .where(and(eq(meetings.status, "open"), inArray(column, chunk))));

  for (const lookup of [...openOn(meetings.meetingLinkId, linkIds), ...openOn(meetings.spaceId, spaceIds)]) {
    collect(await lookup);
  }

  collect(
    await db
      .select(openMeetingSelection)
      .from(meetings)
      .innerJoin(meetingLinks, eq(meetings.meetingLinkId, meetingLinks.id))
      .where(
        and(
          eq(meetings.status, "open"),
          exists(
            db
              .select({ id: meetingConnections.id })
              .from(meetingConnections)
              .where(
                and(
                  eq(meetingConnections.meetingId, meetings.id),
                  eq(meetingConnections.userId, userId),
                  // A token issued and never used is ended by the meeting's
                  // room once it looks, so it cannot keep a thread open with
                  // nobody in it.
                  connectionIsUnfinished(),
                ),
              ),
          ),
        ),
      ),
  );

  return byMeetingId;
}

async function selectConnectedCounts(
  db: Database,
  meetingIds: string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const lookups = boundedStatements(meetingIds, (chunk) =>
    db
      .select({ meetingId: meetingConnections.meetingId, count: count() })
      .from(meetingConnections)
      .where(
        and(
          inArray(meetingConnections.meetingId, chunk),
          connectionIsPresent(),
        ),
      )
      .groupBy(meetingConnections.meetingId));
  for (const lookup of lookups) {
    for (const row of await lookup) counts.set(row.meetingId, row.count);
  }
  return counts;
}

interface LatestMeetingRow {
  threadId: string;
  meetingId: string;
  code: string;
  title: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
  hasSummary: string | null;
}

/**
 * Latest ended Meeting per thread (link or Space), one row per thread via a
 * window function so the whole lookup stays one statement per chunk.
 */
async function selectLatestMeetings(
  db: Database,
  partitionColumn: typeof meetings.meetingLinkId | typeof meetings.spaceId,
  ids: string[],
): Promise<Map<string, LatestMeetingRow>> {
  const byThreadId = new Map<string, LatestMeetingRow>();

  const lookups = boundedStatements(ids, (chunk) => {
    const ranked = db
      .select({
        threadId: sql<string>`${partitionColumn}`.as("thread_id"),
        meetingId: meetings.id,
        code: meetingLinks.code,
        title: meetings.title,
        startedAt: meetings.startedAt,
        endedAt: meetings.endedAt,
        hasSummary: sql<string | null>`${meetingSummaries.id}`.as("summary_id"),
        meetingRank: sql<number>`row_number() over (
          partition by ${partitionColumn}
          order by ${meetings.startedAt} desc, ${meetings.id} desc
        )`.as("meeting_rank"),
      })
      .from(meetings)
      .innerJoin(meetingLinks, eq(meetings.meetingLinkId, meetingLinks.id))
      .leftJoin(meetingSummaries, eq(meetingSummaries.meetingId, meetings.id))
      .where(and(eq(meetings.status, "ended"), inArray(partitionColumn, chunk)))
      .as("ranked_meetings");

    return db
      .select({
        threadId: ranked.threadId,
        meetingId: ranked.meetingId,
        code: ranked.code,
        title: ranked.title,
        startedAt: ranked.startedAt,
        endedAt: ranked.endedAt,
        hasSummary: ranked.hasSummary,
      })
      .from(ranked)
      .where(eq(ranked.meetingRank, 1));
  });
  for (const lookup of lookups) {
    for (const row of await lookup) byThreadId.set(row.threadId, row);
  }

  return byThreadId;
}

function toLatestMeeting(row: LatestMeetingRow | undefined): ThreadLatestMeeting | null {
  if (!row) return null;
  return {
    meetingId: row.meetingId,
    code: row.code,
    title: row.title,
    startedAt: row.startedAt?.toISOString() ?? null,
    endedAt: row.endedAt?.toISOString() ?? null,
    hasSummary: Boolean(row.hasSummary),
  };
}

function latestTime(...values: Array<Date | string | null | undefined>): string | null {
  let max: number | null = null;
  for (const value of values) {
    if (!value) continue;
    const time = typeof value === "string" ? Date.parse(value) : value.getTime();
    if (!Number.isFinite(time)) continue;
    if (max === null || time > max) max = time;
  }
  return max === null ? null : new Date(max).toISOString();
}

/**
 * The inbox: every ongoing conversation the user belongs to — personal links,
 * Spaces, and any open Meeting they started or joined ad hoc — with each thread's
 * open Meeting and latest ended Meeting (Summary availability included).
 *
 * Ordering: currently live threads, then open threads, then last activity.
 */
export async function selectMyThreads(db: Database, user: DashboardUser) {
  const [{ links }, spacesForUser] = await Promise.all([
    selectDashboardMeetingLinks(db, user),
    selectSpacesForUser(db, user.id),
  ]);

  const linkIds = links.map((link) => link.id);
  const spaceIds = spacesForUser.map((space) => space.id);

  const openByMeetingId = await selectOpenMeetings(db, user.id, linkIds, spaceIds);
  const [connectedCounts, latestByLinkId, latestBySpaceId] = await Promise.all([
    selectConnectedCounts(db, Array.from(openByMeetingId.keys())),
    selectLatestMeetings(db, meetings.meetingLinkId, linkIds),
    selectLatestMeetings(db, meetings.spaceId, spaceIds),
  ]);

  const linkIdSet = new Set(linkIds);
  const spaceIdSet = new Set(spaceIds);

  const openByLinkId = new Map<string, OpenMeetingRow>();
  const openBySpaceId = new Map<string, OpenMeetingRow>();
  const adHocOpen: OpenMeetingRow[] = [];
  for (const row of openByMeetingId.values()) {
    if (row.spaceId && spaceIdSet.has(row.spaceId)) {
      openBySpaceId.set(row.spaceId, row);
    } else if (linkIdSet.has(row.meetingLinkId)) {
      openByLinkId.set(row.meetingLinkId, row);
    } else {
      adHocOpen.push(row);
    }
  }

  const toOpenMeeting = (row: OpenMeetingRow): ThreadOpenMeeting => ({
    meetingId: row.meetingId,
    code: row.code,
    title: row.title,
    startedAt: row.startedAt?.toISOString() ?? null,
    participantCount: connectedCounts.get(row.meetingId) ?? 0,
  });
  const toOptionalOpenMeeting = (row: OpenMeetingRow | undefined) =>
    row ? toOpenMeeting(row) : null;

  const threads: Thread[] = [];

  for (const link of links) {
    const openMeeting = toOptionalOpenMeeting(openByLinkId.get(link.id));
    const latestMeeting = toLatestMeeting(latestByLinkId.get(link.id));
    threads.push({
      kind: "personal",
      id: link.id,
      slug: null,
      code: link.code,
      title: link.title ?? "Personal meeting",
      defaultTitle: link.title,
      joinPolicy: link.joinPolicy,
      openMeeting,
      latestMeeting,
      lastActivityAt: latestTime(openMeeting?.startedAt, latestMeeting?.endedAt, link.lastUsedAt),
    });
  }

  for (const space of spacesForUser) {
    const openMeeting = toOptionalOpenMeeting(openBySpaceId.get(space.id));
    const latestMeeting = toLatestMeeting(latestBySpaceId.get(space.id));
    threads.push({
      kind: "space",
      id: space.id,
      slug: space.slug,
      code: null,
      title: space.name,
      openMeeting,
      latestMeeting,
      lastActivityAt: latestTime(openMeeting?.startedAt, latestMeeting?.endedAt, space.updatedAt),
    });
  }

  for (const row of adHocOpen) {
    const openMeeting = toOpenMeeting(row);
    threads.push({
      kind: "meeting",
      id: row.meetingId,
      slug: null,
      code: row.code,
      title: row.title ?? row.code,
      openMeeting,
      latestMeeting: null,
      lastActivityAt: openMeeting.startedAt,
    });
  }

  threads.sort((a, b) => {
    const aLive = (a.openMeeting?.participantCount ?? 0) > 0;
    const bLive = (b.openMeeting?.participantCount ?? 0) > 0;
    if (aLive !== bLive) return aLive ? -1 : 1;
    if (Boolean(a.openMeeting) !== Boolean(b.openMeeting)) {
      return a.openMeeting ? -1 : 1;
    }
    const aTime = a.lastActivityAt ? Date.parse(a.lastActivityAt) : 0;
    const bTime = b.lastActivityAt ? Date.parse(b.lastActivityAt) : 0;
    if (aTime !== bTime) return bTime - aTime;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });

  return { threads };
}

export async function getMyThreadsImpl({ context: { user, db } }: { context: AuthFnContext }) {
  return selectMyThreads(db, user);
}
