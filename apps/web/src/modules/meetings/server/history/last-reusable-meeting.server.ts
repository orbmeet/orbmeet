/**
 * Server implementations behind the RPC declarations in this directory.
 * Split from the sibling RPC file so the declaration file carries no
 * DB/Drizzle imports and stays safe to include in client route graphs.
 */

import type { Database } from "@orbmeet/db";
import {
  meetingAdmissions,
  meetingConnections,
  meetingLinks,
  meetings,
  spaceMembers,
  spaces,
} from "@orbmeet/db/schema";
import { and, desc, eq, gt, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { AuthFnContext } from "@/app/bootstrap/middleware";
import { connectionIsPresent } from "@/modules/meetings/server/connection/state";

export type MyLastReusableMeeting = {
  code: string;
  linkTitle: string | null;
  spaceKind: "personal" | "shared";
  spaceName: string | null;
  spaceSlug: string | null;
  lastJoinedAt: string;
  hasOpenMeeting: boolean;
  liveParticipantCount: number;
};

/**
 * The most recent reusable Meeting link the user has joined — a shortcut back
 * to a shared Space's front door or the user's own personal reusable link.
 * One-time Meetings are excluded on purpose: "Start a meeting"
 * already mints those, and a spent link is not worth re-surfacing.
 *
 * The query drives from the user's own admissions so row reads stay
 * proportional to their history (as selectMyMeetings does); the reusable
 * filter turns it into "reusable links I've joined" and MAX(created_at) per
 * link picks the most recent. Starting a meeting routes through the same join
 * path, so a host admission already covers meetings the user started.
 *
 * Access is re-checked at read time so a removed Space member (or an expired
 * personal link) is never prompted to rejoin a Meeting they can no longer enter.
 */
export async function selectMyLastReusableMeeting(
  db: Database,
  user: { id: string },
  now: Date,
): Promise<MyLastReusableMeeting | null> {
  const candidate = await db
    .select({
      linkId: meetingLinks.id,
      code: meetingLinks.code,
      linkTitle: meetingLinks.title,
      spaceKind: meetingLinks.spaceKind,
      spaceName: spaces.name,
      spaceSlug: spaces.slug,
      // max() is an aggregate, so it bypasses the column's timestamp mapper and
      // returns the raw stored epoch seconds. Convert back to a Date here.
      lastJoinedAt: sql<number>`max(${meetingAdmissions.createdAt})`.as("last_joined_at"),
    })
    .from(meetingAdmissions)
    .innerJoin(meetings, eq(meetings.id, meetingAdmissions.meetingId))
    .innerJoin(meetingLinks, eq(meetingLinks.id, meetings.meetingLinkId))
    .innerJoin(spaces, eq(spaces.id, meetingLinks.spaceId))
    .leftJoin(
      spaceMembers,
      and(eq(spaceMembers.spaceId, meetingLinks.spaceId), eq(spaceMembers.userId, user.id)),
    )
    .where(
      and(
        eq(meetingAdmissions.subjectUserId, user.id),
        eq(meetingAdmissions.admissionStatus, "approved"),
        eq(meetingLinks.reusePolicy, "reusable"),
        isNull(meetingLinks.archivedAt),
        // Drop dead links: reusable Space default links never expire, personal
        // reusable links do.
        // Use the column-aware operator so Drizzle maps Date to epoch seconds
        // before binding it to D1.
        or(isNull(meetingLinks.expiresAt), gt(meetingLinks.expiresAt, now)),
        // Re-check current access. Shared spaces require live membership and an
        // unarchived space; personal reusable links must be the user's own.
        or(
          and(
            eq(meetingLinks.spaceKind, "shared"),
            isNull(spaces.archivedAt),
            isNotNull(spaceMembers.id),
          ),
          and(eq(meetingLinks.spaceKind, "personal"), eq(spaces.ownerUserId, user.id)),
        ),
      ),
    )
    .groupBy(
      meetingLinks.id,
      meetingLinks.code,
      meetingLinks.title,
      meetingLinks.spaceKind,
      spaces.name,
      spaces.slug,
    )
    .orderBy(desc(sql`max(${meetingAdmissions.createdAt})`))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  if (!candidate) return null;

  // A reusable link has at most one open occurrence (meetings_open_link_unique_idx),
  // so probe it directly to answer "is the room live right now".
  const openMeeting = await db
    .select({ id: meetings.id })
    .from(meetings)
    .where(and(eq(meetings.meetingLinkId, candidate.linkId), eq(meetings.status, "open")))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  let liveParticipantCount = 0;
  if (openMeeting) {
    liveParticipantCount = await db
      .select({ count: sql<number>`count(*)` })
      .from(meetingConnections)
      .where(
        and(
          eq(meetingConnections.meetingId, openMeeting.id),
          connectionIsPresent(),
        ),
      )
      .limit(1)
      .then((rows) => Number(rows[0]?.count ?? 0));
  }

  return {
    code: candidate.code,
    linkTitle: candidate.linkTitle,
    spaceKind: candidate.spaceKind,
    // The personal space is not addressable as a space in client payloads.
    spaceName: candidate.spaceKind === "shared" ? candidate.spaceName : null,
    spaceSlug: candidate.spaceKind === "shared" ? candidate.spaceSlug : null,
    lastJoinedAt: new Date(Number(candidate.lastJoinedAt) * 1000).toISOString(),
    hasOpenMeeting: Boolean(openMeeting),
    liveParticipantCount,
  };
}

export async function getMyLastReusableMeetingImpl({
  context: { user, db },
}: {
  context: AuthFnContext;
}) {
  return selectMyLastReusableMeeting(db, user, new Date());
}
