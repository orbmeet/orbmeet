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
import { and, count, desc, eq, exists, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
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

  const connected = db
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
    );

  // Each await is a round trip to D1, so these leave together.
  for (const rows of await Promise.all([
    ...openOn(meetings.meetingLinkId, linkIds),
    ...openOn(meetings.spaceId, spaceIds),
    connected,
  ])) {
    collect(rows);
  }

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
 * Latest ended Meeting per thread (link or Space). Each thread is one probe of
 * its index, however many Meetings it has held, and the ids travel as a single
 * JSON parameter, so the lookup stays one statement.
 */
async function selectLatestMeetings(
  db: Database,
  threadColumn: "meetingLinkId" | "spaceId",
  ids: string[],
): Promise<Map<string, LatestMeetingRow>> {
  const byThreadId = new Map<string, LatestMeetingRow>();
  if (ids.length === 0) return byThreadId;

  const candidate = alias(meetings, "latest_candidate");
  const latestId = db
    .select({ id: candidate.id })
    .from(candidate)
    .where(and(eq(candidate[threadColumn], sql`thread.value`), eq(candidate.status, "ended")))
    .orderBy(desc(candidate.startedAt), desc(candidate.id))
    .limit(1);

  const rows = await db
    .select({
      threadId: sql<string>`thread.value`,
      meetingId: meetings.id,
      code: meetingLinks.code,
      title: meetings.title,
      startedAt: meetings.startedAt,
      endedAt: meetings.endedAt,
      hasSummary: sql<string | null>`${meetingSummaries.id}`,
    })
    .from(sql`json_each(${JSON.stringify(ids)}) as thread`)
    .innerJoin(meetings, sql`${meetings.id} = (${latestId})`)
    .innerJoin(meetingLinks, eq(meetings.meetingLinkId, meetingLinks.id))
    .leftJoin(meetingSummaries, eq(meetingSummaries.meetingId, meetings.id));
  for (const row of rows) byThreadId.set(row.threadId, row);

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

  const [openByMeetingId, latestByLinkId, latestBySpaceId] = await Promise.all([
    selectOpenMeetings(db, user.id, linkIds, spaceIds),
    selectLatestMeetings(db, "meetingLinkId", linkIds),
    selectLatestMeetings(db, "spaceId", spaceIds),
  ]);
  const connectedCounts = await selectConnectedCounts(db, Array.from(openByMeetingId.keys()));

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
