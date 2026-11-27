import "@tanstack/react-start/server-only";
import type { Database } from "@orbmeet/db";
import { getSpaceAccess } from "@/modules/spaces/server/helpers";
import { sendMeetingRoomRpc } from "@/platform/realtime/meeting-room-rpc.server";
import { getGuestCookieSecret } from "../access/guest-cookie.server";
import type { CoordinatorReply, CoordinatorRequest, SubjectInput } from "./api";
import type { SpaceRole } from "./model";

/**
 * Send one request to a meeting's MeetingRoom, the single writer of its live
 * state. A refusal throws the AppError it is. Effects the request sets off
 * keep running in the room after the reply.
 *
 * A transient infrastructure failure (the object reset by a deploy, a lost
 * connection) is retried on a fresh stub, though the first try may have
 * committed: every request is safe to repeat. The core answers a command
 * repeated as it answered it the first time, changing nothing more (held by
 * step-ending.test.ts, "every command, repeated"); observations and wakes are
 * idempotent. An overloaded room is not retried.
 */
export function callCoordinator(env: Env, request: CoordinatorRequest): Promise<CoordinatorReply> {
  return sendMeetingRoomRpc(env, request);
}

/**
 * A user's current standing in a meeting's Space, as its room reads it:
 * `admin` for the Space's owner and admins, who host; `member`, who may enter
 * a shared-Space meeting (and may stand in as host, see `roleOf`); `visitor`
 * for anyone else, who enters a personal meeting through its link policy.
 */
export async function spaceRoleFor(db: Database, meeting: { spaceId: string }, userId: string): Promise<SpaceRole> {
  const access = await getSpaceAccess(db, meeting.spaceId, userId);
  if (!access?.capabilities.canView) return "visitor";
  return access.capabilities.canManage ? "admin" : "member";
}

/**
 * Ask the meeting's room whether a signed-in user may moderate there now:
 * from a seat, as a host or moderator. The room is the only judge of live
 * authority; throws its refusal.
 */
export async function authorizeInMeeting(env: Env, meetingId: string, userId: string): Promise<void> {
  await callCoordinator(env, {
    kind: "command",
    meetingId,
    command: { kind: "authorize", subject: userSubject(userId), as: "moderator" },
  });
}

/** A signed-in user; the coordinator reads their Space authority itself. */
export function userSubject(userId: string): SubjectInput {
  return { kind: "user", userId };
}

/**
 * A guest is known only by an admission and the HttpOnly secret its cookie
 * carries. `attemptId` names the admission when the client only knows its
 * connection.
 */
async function guestSubject(
  db: Database,
  meetingId: string,
  ids: { admissionId?: string | null; attemptId?: string | null },
): Promise<SubjectInput> {
  let admissionId = ids.admissionId ?? null;
  if (!admissionId && ids.attemptId) {
    const attempt = await db.query.meetingConnections.findFirst({
      where: { id: ids.attemptId, meetingId },
      columns: { admissionId: true },
    });
    admissionId = attempt?.admissionId ?? null;
  }
  return {
    kind: "guest",
    admissionId,
    secret: admissionId ? getGuestCookieSecret(admissionId) : null,
  };
}

/** The subject for a request: the signed-in user, or the guest the cookie proves. */
export async function requestSubject(
  db: Database,
  meetingId: string,
  user: { id: string } | null,
  ids: { admissionId?: string | null; attemptId?: string | null } = {},
): Promise<SubjectInput> {
  return user ? userSubject(user.id) : guestSubject(db, meetingId, ids);
}
