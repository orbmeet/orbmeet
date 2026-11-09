import type { Database } from "@orbmeet/db";
import { meetingLinks, spaces } from "@orbmeet/db/schema";
import { and, desc, eq, gte, isNull, or } from "drizzle-orm";
import type { SubscriptionTier } from "@/modules/billing/contract/types";

export interface DashboardUser {
  id: string;
  plan: SubscriptionTier | null;
}

export async function selectDashboardMeetingLinks(db: Database, user: DashboardUser) {
  // Explicit reusable links owned by the user's personal space, found in the
  // same statement: each separate query is a round trip to D1.
  const linkRows = await db
    .select({
      id: meetingLinks.id,
      code: meetingLinks.code,
      reusePolicy: meetingLinks.reusePolicy,
      title: meetingLinks.title,
      joinPolicy: meetingLinks.joinPolicy,
      lastUsedAt: meetingLinks.lastUsedAt,
      expiresAt: meetingLinks.expiresAt,
    })
    .from(meetingLinks)
    .innerJoin(spaces, eq(spaces.id, meetingLinks.spaceId))
    .where(
      and(
        eq(spaces.kind, "personal"),
        eq(spaces.ownerUserId, user.id),
        eq(meetingLinks.reusePolicy, "reusable"),
        isNull(meetingLinks.archivedAt),
        or(isNull(meetingLinks.expiresAt), gte(meetingLinks.expiresAt, new Date())),
      ),
    )
    .orderBy(desc(meetingLinks.lastUsedAt));

  return {
    links: linkRows.map((l) => ({
      ...l,
      lastUsedAt: l.lastUsedAt?.toISOString() ?? null,
      expiresAt: l.expiresAt?.toISOString() ?? null,
    })),
  };
}
