/**
 * Server implementations behind the RPC declarations in this directory.
 * Split from the sibling RPC file so the declaration file carries no
 * DB/Drizzle imports and stays safe to include in client route graphs.
 */

import type { Database } from "@orbmeet/db";
import { meetings, meetingLinks } from "@orbmeet/db/schema";
import { eq, and, isNull, sql } from "drizzle-orm";
import { Errors } from "@/lib/app-errors";
import { getRunChanges } from "@/platform/database/db-utils";
import { enforceRateLimit } from "@/platform/http/rate-limit.server";
import type { AuthFnContext } from "@/app/bootstrap/middleware";
import type { UpdateMeetingLinkInput } from "./dashboard.functions";
import type { ArchiveMeetingLinkInput } from "./dashboard.functions";
import { findPersonalSpaceId } from "@/modules/spaces/server/personal";

export async function archiveMeetingLinkIfIdle(
  db: Database,
  meetingLinkId: string,
  personalSpaceId: string,
  now = new Date(),
): Promise<boolean> {
  const result = await db
    .update(meetingLinks)
    .set({ archivedAt: now, updatedAt: now })
    .where(
      and(
        eq(meetingLinks.id, meetingLinkId),
        eq(meetingLinks.spaceId, personalSpaceId),
        eq(meetingLinks.reusePolicy, "reusable"),
        isNull(meetingLinks.archivedAt),
        sql`not exists ${db
          .select({ id: meetings.id })
          .from(meetings)
          .where(and(eq(meetings.meetingLinkId, meetingLinkId), eq(meetings.status, "open")))}`,
      ),
    )
    .run();

  return getRunChanges(result) > 0;
}

export async function updateMeetingLinkImpl({
  data,
  context: { user, env, db },
}: {
  data: UpdateMeetingLinkInput;
  context: AuthFnContext;
}) {
  await enforceRateLimit(env, `meeting-link:update:${user.id}`);

  // No personal space means no links of the user's own to change.
  const personalSpaceId = await findPersonalSpaceId(db, user.id);
  if (!personalSpaceId) throw Errors.NOT_FOUND("Meeting link");

  const updates: Pick<typeof meetingLinks.$inferInsert, "updatedAt"> &
    Partial<Pick<typeof meetingLinks.$inferInsert, "title" | "allowGuests" | "joinPolicy">> = {
    updatedAt: new Date(),
  };
  if (data.title !== undefined) updates.title = data.title || null;
  if (data.allowGuests !== undefined) updates.allowGuests = data.allowGuests;
  if (data.joinPolicy !== undefined) updates.joinPolicy = data.joinPolicy;

  const result = await db
    .update(meetingLinks)
    .set(updates)
    .where(
      and(
        eq(meetingLinks.id, data.meetingLinkId),
        eq(meetingLinks.spaceId, personalSpaceId),
        eq(meetingLinks.reusePolicy, "reusable"),
        isNull(meetingLinks.archivedAt),
      ),
    )
    .run();

  if (getRunChanges(result) === 0) throw Errors.NOT_FOUND("Meeting link");
  return { success: true };
}

export async function archiveMeetingLinkImpl({
  data,
  context: { user, env, db },
}: {
  data: ArchiveMeetingLinkInput;
  context: AuthFnContext;
}) {
  await enforceRateLimit(env, `meeting-link:archive:${user.id}`);

  // No personal space means no links of the user's own to change.
  const personalSpaceId = await findPersonalSpaceId(db, user.id);
  if (!personalSpaceId) throw Errors.NOT_FOUND("Meeting link");

  const archived = await archiveMeetingLinkIfIdle(db, data.meetingLinkId, personalSpaceId);
  if (!archived) {
    const openMeeting = await db
      .select({ id: meetings.id })
      .from(meetings)
      .innerJoin(meetingLinks, eq(meetings.meetingLinkId, meetingLinks.id))
      .where(
        and(
          eq(meetingLinks.id, data.meetingLinkId),
          eq(meetingLinks.spaceId, personalSpaceId),
          eq(meetingLinks.reusePolicy, "reusable"),
          isNull(meetingLinks.archivedAt),
          eq(meetings.status, "open"),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (openMeeting) {
      throw Errors.VALIDATION("End the active Meeting before removing this link");
    }
    throw Errors.NOT_FOUND("Meeting link");
  }
  return { success: true };
}
