import type { Database } from "@orbmeet/db";
import { verifyWhiteboardJWT } from "@orbmeet/whiteboard-core/whiteboard-jwt";
import { whiteboardJwtKeyring } from "@/platform/realtime/nodes";
import { syncRoomIdFromWhiteboardRoomId } from "@orbmeet/whiteboard-core/whiteboard-room-id";
import { resolveMeetingIdForWhiteboardConnection } from "@/modules/whiteboards/server/documents";
import {
  getActiveWhiteboardParticipantAccess,
  resolveSoloWhiteboardEditor,
  type ActiveWhiteboardParticipantAccess,
} from "@/modules/whiteboards/server/meeting/access";
import { loadSpaceEntitlement } from "@/modules/billing/server/entitlements.server";

type WhiteboardBearerAccess = Omit<ActiveWhiteboardParticipantAccess, "meetingId"> & {
  meetingId: string | null;
};

export interface ActiveWhiteboardAuth {
  meetingId: string | null;
  syncRoomId: string;
  token: string;
  access: WhiteboardBearerAccess;
}

export async function verifyActiveWhiteboardBearer(
  request: Request,
  env: Env,
  db: Database,
): Promise<ActiveWhiteboardAuth | Response> {
  const authHeader = request.headers.get("Authorization");
  const token = authHeader?.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length).trim()
    : null;

  if (!token) {
    return new Response("Unauthorized", { status: 401 });
  }

  let claims: Awaited<ReturnType<typeof verifyWhiteboardJWT>>;
  try {
    // Minted for whichever node held the board; its key names that node.
    claims = await verifyWhiteboardJWT(token, whiteboardJwtKeyring(env));
  } catch {
    return new Response("Unauthorized", { status: 401 });
  }

  const syncRoomId = syncRoomIdFromWhiteboardRoomId(claims.sid);
  if (!syncRoomId) {
    return new Response("Forbidden", { status: 403 });
  }
  if (claims.service === "solo") {
    const isValidSoloClaim = claims.connectionId === "solo"
      && claims.sub === claims.grantPrincipal.id
      && claims.grantPrincipal.type === "user"
      && claims.role === "participant"
      && claims.capabilities.canEditWhiteboard
      && !claims.capabilities.canControlSurface
      && !claims.capabilities.canManageWhiteboard;
    if (!isValidSoloClaim) return new Response("Forbidden", { status: 403 });

    const board = await resolveSoloWhiteboardEditor(db, syncRoomId, claims.sub);
    if (!board || (claims.documentId && claims.documentId !== board.whiteboardId)) {
      return new Response("Forbidden", { status: 403 });
    }
    const entitlement = await loadSpaceEntitlement(db, board.spaceId);
    return {
      meetingId: null,
      syncRoomId,
      token,
      access: {
        meetingId: null,
        billingPrincipalType: entitlement.billingPrincipal.type,
        billingPrincipalId: entitlement.billingPrincipal.id,
        connectionId: claims.connectionId,
        admissionId: null,
        participantIdentity: claims.sub,
        userId: claims.sub,
        role: claims.role,
        capabilities: claims.capabilities,
        grantPrincipal: claims.grantPrincipal,
        whiteboardEditGranted: false,
        canEditWhiteboard: true,
      },
    };
  }
  const meetingId = await resolveMeetingIdForWhiteboardConnection(
    db,
    syncRoomId,
    claims.service === "recorder" ? null : claims.connectionId,
  );
  if (!meetingId) return new Response("Forbidden", { status: 403 });

  const access = await getActiveWhiteboardParticipantAccess(db, meetingId, claims.connectionId, syncRoomId);
  if (!access || access.participantIdentity !== claims.sub) {
    return new Response("Forbidden", { status: 403 });
  }

  return { meetingId, syncRoomId, token, access };
}
