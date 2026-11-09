import "@tanstack/react-start/server-only";

import type { Database } from "@orbmeet/db";
import { meetingLinks, meetingScheduleNotifications, meetingSchedules, organizations, spaceDefaultMeetingLinks, spaces } from "@orbmeet/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { getRunChanges } from "@/platform/database/db-utils";

export async function requestSpaceDeletion(
  db: Database,
  spaceId: string,
  userId: string,
  now = new Date(),
): Promise<boolean> {
  const [spaceResult] = await db.batch([
    db
      .update(spaces)
      .set({ archivedAt: now, updatedAt: now })
      .where(
        and(
          eq(spaces.id, spaceId),
          sql`${spaces.archivedAt} is null`,
          sql`(
              ${spaces.ownerUserId} = ${userId}
              or exists (
                select 1 from ${organizations} owner_authority
                where owner_authority.id = ${spaces.organizationId}
                  and owner_authority.owner_id = ${userId}
              )
              or exists (
                select 1 from organization_members authority
                where authority.organization_id = ${spaces.organizationId}
                  and authority.user_id = ${userId}
                  and authority.role = 'admin'
              )
            )`,
        ),
      ),
    // A Space's default link must stay active for as long as it is the default
    // (a database trigger enforces it), so it stops being one first. Archiving
    // the links without this failed the whole deletion.
    db
      .delete(spaceDefaultMeetingLinks)
      .where(
        and(
          eq(spaceDefaultMeetingLinks.spaceId, spaceId),
          sql`exists (
              select 1 from ${spaces}
              where ${spaces.id} = ${spaceId}
                and ${spaces.archivedAt} is not null
            )`,
        ),
      ),
    db
      .update(meetingLinks)
      .set({ archivedAt: now, updatedAt: now })
      .where(
        and(
          eq(meetingLinks.spaceId, spaceId),
          sql`${meetingLinks.archivedAt} is null`,
          sql`exists (
              select 1 from ${spaces}
              where ${spaces.id} = ${spaceId}
                and ${spaces.archivedAt} is not null
            )`,
        ),
      ),
    db
      .update(meetingScheduleNotifications)
      .set({
        status: "failed",
        lastError: "Suppressed because the Space was deleted",
      })
      .where(
        and(
          eq(meetingScheduleNotifications.status, "pending"),
          sql`exists (
              select 1 from ${meetingSchedules}
              inner join ${spaces} on ${spaces.id} = ${meetingSchedules.spaceId}
              where ${meetingSchedules.id} = ${meetingScheduleNotifications.scheduleId}
                and ${meetingSchedules.spaceId} = ${spaceId}
                and ${spaces.archivedAt} is not null
            )`,
        ),
      ),
  ]);

  return getRunChanges(spaceResult) > 0;
}
