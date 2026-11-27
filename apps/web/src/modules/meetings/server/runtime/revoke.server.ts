import "@tanstack/react-start/server-only";
import type { Database } from "@orbmeet/db";
import { meetingAdmissions, meetings } from "@orbmeet/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import { logError } from "@/lib/logger";
import { callCoordinator } from "./client.server";

/**
 * Tell every open meeting where the user holds a live admission to revoke it
 * (optionally only in one Space). Each coordinator ends the user's attempts
 * and removes them from the room.
 *
 * Best effort per meeting: a coordinator that misses this finds the change
 * on its periodic authority check (AUTHORITY_CHECK_MS), and account deletion
 * also blocks their session.
 */
export async function revokeFromOpenMeetings(
  db: Database,
  env: Env,
  userId: string,
  reason: string,
  scope: { spaceId?: string } = {},
): Promise<void> {
  const rows = await db
    .selectDistinct({ meetingId: meetings.id })
    .from(meetingAdmissions)
    .innerJoin(meetings, eq(meetings.id, meetingAdmissions.meetingId))
    .where(and(
      eq(meetingAdmissions.subjectUserId, userId),
      inArray(meetingAdmissions.admissionStatus, ["pending", "approved"]),
      eq(meetings.status, "open"),
      scope.spaceId ? eq(meetings.spaceId, scope.spaceId) : undefined,
    ));
  await Promise.all(rows.map(async ({ meetingId }) => {
    try {
      await callCoordinator(env, { kind: "command", meetingId, command: { kind: "revoke", userId, reason } });
    } catch (error) {
      logError("[meetings] Could not revoke a user from a meeting", { userId, meetingId }, error);
    }
  }));
}
