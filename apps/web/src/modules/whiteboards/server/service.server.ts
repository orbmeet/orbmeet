import "@tanstack/react-start/server-only";
import { type Database } from "@orbmeet/db";
import { Errors } from "@/lib/app-errors";
import {
  assertActiveMeetingParticipantWithSpaceAccess,
  assertMeetingExists,
} from "@/modules/meetings/server/access/access-assertions";
import { findWhiteboardEligibleConnectionById } from "@/modules/meetings/server/room/connection-queries";
import type { RequestFnContext } from "@/app/bootstrap/middleware";
import { getGuestCookieSecret } from "@/modules/meetings/server/access/guest-cookie.server";
import { verifyGuestAdmissionBySecret } from "@/modules/meetings/server/access/guest-admission";
import { enforceRateLimit } from "@/platform/http/rate-limit.server";
import {
  whiteboardCapabilitiesForMeetingRole,
  whiteboardRoleForMeetingConnection,
} from "@/modules/whiteboards/server/meeting/role";
import {
  resolveWhiteboardCapabilities,
  whiteboardGrantPrincipalForConnection,
} from "@/modules/whiteboards/server/meeting/grants";
import { isWhiteboardConfigured } from "@/modules/whiteboards/server/config.server";

async function resolveAuthenticatedCallerIdentity(
  db: Database,
  meetingId: string,
  userId: string,
  connectionId?: string,
) {
  if (!connectionId) throw Errors.UNAUTHORIZED();

  const meeting = await assertMeetingExists(db, meetingId, { requireActive: true });
  const connection = await findWhiteboardEligibleConnectionById(db, meetingId, connectionId);
  if (!connection || connection.userId !== userId) throw Errors.FORBIDDEN();
  const grantPrincipal = whiteboardGrantPrincipalForConnection(connection);
  if (!grantPrincipal) throw Errors.FORBIDDEN();
  // The role the meeting's room decided and projected onto the connection.
  const baseCapabilities = whiteboardCapabilitiesForMeetingRole(connection.role);
  const { capabilities } = await resolveWhiteboardCapabilities(db, {
    meetingId: meeting.id,
    principal: grantPrincipal,
    base: baseCapabilities,
  });

  const participant = connection.admissionId
    ? await db.query.meetingAdmissions.findFirst({
        where: { id: connection.admissionId },
      })
    : null;

  return {
    connectionId: connection.connectionId,
    identity: connection.livekitIdentity,
    displayName: participant?.displayName ?? null,
    role: whiteboardRoleForMeetingConnection(connection),
    capabilities,
    grantPrincipal,
    canEditWhiteboard: capabilities.canEditWhiteboard,
  };
}

async function resolveGuestCallerIdentity(
  db: Database,
  meetingId: string,
  connectionId: string | undefined,
) {
  if (!connectionId) throw Errors.UNAUTHORIZED();

  const meeting = await assertMeetingExists(db, meetingId, { requireActive: true });
  const connection = await findWhiteboardEligibleConnectionById(db, meetingId, connectionId);
  if (!connection || connection.userId !== null || !connection.admissionId) {
    throw Errors.FORBIDDEN();
  }
  const grantPrincipal = whiteboardGrantPrincipalForConnection(connection);
  if (!grantPrincipal) throw Errors.FORBIDDEN();
  // The role the meeting's room decided and projected onto the connection.
  const baseCapabilities = whiteboardCapabilitiesForMeetingRole(connection.role);
  const { capabilities } = await resolveWhiteboardCapabilities(db, {
    meetingId: meeting.id,
    principal: grantPrincipal,
    base: baseCapabilities,
  });

  const guestSecretHash = getGuestCookieSecret(connection.admissionId);
  await verifyGuestAdmissionBySecret(db, meetingId, connection.admissionId, guestSecretHash);

  return {
    connectionId: connection.connectionId,
    identity: connection.livekitIdentity,
    // The name the guest joined under, not the word "Guest". A host reading
    // "Guest requested whiteboard edit access" with three guests in the room
    // has been told nothing they can act on; the admission has carried the
    // typed name all along.
    displayName: connection.displayName,
    role: whiteboardRoleForMeetingConnection(connection),
    capabilities,
    grantPrincipal,
    canEditWhiteboard: capabilities.canEditWhiteboard,
  };
}

/**
 * Resolve the signed-in user or admitted guest behind a live whiteboard
 * request and throttle them under `rateLimitPrefix`.
 *
 * `connectionId` is client-supplied and only verified against the admission
 * further down, so a guest is throttled by connection *and* by IP: the IP
 * bucket is the pre-auth backstop against minting connection ids at will.
 */
export async function resolveActiveWhiteboardCallerIdentity(
  { db, env, user, clientIP }: RequestFnContext,
  meetingId: string,
  connectionId: string | undefined,
  rateLimitPrefix: string,
) {
  if (!isWhiteboardConfigured(env)) {
    throw Errors.CONFIG_ERROR("Whiteboard not configured");
  }

  if (user) {
    await enforceRateLimit(env, `${rateLimitPrefix}:${user.id}`);
    const meeting = await assertMeetingExists(db, meetingId, { requireActive: true });
    await assertActiveMeetingParticipantWithSpaceAccess(db, meeting.id, user.id, { meeting });
    const callerIdentity = await resolveAuthenticatedCallerIdentity(
      db,
      meeting.id,
      user.id,
      connectionId,
    );
    return { meeting, callerIdentity };
  }

  await enforceRateLimit(env, `${rateLimitPrefix}:guest:${connectionId ?? "unknown"}`);
  await enforceRateLimit(env, `${rateLimitPrefix}:ip:${clientIP}`);
  const meeting = await assertMeetingExists(db, meetingId, { requireActive: true });
  const callerIdentity = await resolveGuestCallerIdentity(db, meeting.id, connectionId);
  return { meeting, callerIdentity };
}
