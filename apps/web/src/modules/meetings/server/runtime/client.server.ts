import "@tanstack/react-start/server-only";
import type { Database } from "@orbmeet/db";
import { getSpaceAccess } from "@/modules/spaces/server/helpers";
import { rpcValueOf } from "@/platform/runtime/rpc-result";
import { getGuestCookieSecret } from "../access/guest-cookie.server";
import type { CoordinatorReply, CoordinatorRequest, SubjectInput } from "./api";
import type { RoomResult } from "./meeting-room";
import type { SpaceRole } from "./model";

const ROOM_CALL_ATTEMPTS = 3;
const ROOM_CALL_BACKOFF_MS = 100;
/**
 * How long a join or a command waits in its meeting's room before the room
 * refuses it: inside the 25s a joining client waits for its answer, with room
 * for the Worker's own work around the call.
 */
const ROOM_CALL_PATIENCE_MS = 20_000;

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
export async function callCoordinator(env: Env, request: CoordinatorRequest): Promise<CoordinatorReply> {
  if ((request.kind === "join" || request.kind === "command") && request.deadline === undefined) {
    request = { ...request, deadline: Date.now() + ROOM_CALL_PATIENCE_MS };
  }
  for (let attempt = 1; ; attempt += 1) {
    let result: RoomResult;
    try {
      result = await sendToRoom(env, request);
    } catch (error) {
      const { retryable, overloaded } = (error ?? {}) as { retryable?: boolean; overloaded?: boolean };
      if (!retryable || overloaded || attempt >= ROOM_CALL_ATTEMPTS) throw error;
      await new Promise((resolve) => setTimeout(resolve, ROOM_CALL_BACKOFF_MS * 2 ** attempt * Math.random()));
      continue;
    }
    return rpcValueOf(result);
  }
}

/** One RPC to the room, on a fresh stub: a failed stub stays broken. */
async function sendToRoom(env: Env, request: CoordinatorRequest): Promise<RoomResult> {
  const room = env.MEETING_ROOM.get(env.MEETING_ROOM.idFromName(request.meetingId));
  return room.handle(request);
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
    command: { kind: "authorize", subject: userSubject(userId) },
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
