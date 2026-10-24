import type { Database } from "@orbmeet/db";
import { meetingLinks } from "@orbmeet/db/schema";
import { and, desc, eq, gte, isNull, or } from "drizzle-orm";
import type { SubscriptionTier } from "@/modules/billing/contract/types";
import { findPersonalSpaceId } from "@/modules/spaces/server/personal";

export interface DashboardUser {
  id: string;
  plan: SubscriptionTier | null;
}

export async function selectDashboardMeetingLinks(db: Database, user: DashboardUser) {
  // Explicit reusable links owned by the user's personal space.
  const personalSpaceId = await findPersonalSpaceId(db, user.id);
  if (!personalSpaceId) return { links: [] };
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
    .where(
      and(
        eq(meetingLinks.spaceId, personalSpaceId),
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
