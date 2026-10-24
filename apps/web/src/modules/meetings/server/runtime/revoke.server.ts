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

/**
 * Tell every open meeting of a Space where the user holds a live admission
 * what their Space authority is now. Every change to a member's role goes
 * through here; without it a room would only learn of the change when that
 * user next asked it something.
 */
export async function refreshSpaceAuthorityInOpenMeetings(
  db: Database,
  env: Env,
  userId: string,
  spaceId: string,
  reason: string,
): Promise<void> {
  const rows = await db
    .selectDistinct({ meetingId: meetings.id })
    .from(meetingAdmissions)
    .innerJoin(meetings, eq(meetings.id, meetingAdmissions.meetingId))
    .where(and(
      eq(meetingAdmissions.subjectUserId, userId),
      inArray(meetingAdmissions.admissionStatus, ["pending", "approved"]),
      eq(meetings.status, "open"),
      eq(meetings.spaceId, spaceId),
    ));
  // Each coordinator reads the role itself, in order with what it already
  // applied: a role read here could reach it after a newer one.
  await Promise.all(rows.map(async ({ meetingId }) => {
    try {
      await callCoordinator(env, {
        kind: "command",
        meetingId,
        command: { kind: "refreshAuthority", userId, reason },
      });
    } catch (error) {
      logError("[meetings] Could not refresh a user's authority in a meeting", { userId, meetingId }, error);
    }
  }));
}
