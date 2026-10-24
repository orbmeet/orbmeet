import { createDb, type Database } from "@orbmeet/db";
import {
  MAX_AUTHORITY_CLAIMS,
  type AuthorityClaim,
  type AuthorityVerdict,
} from "@orbmeet/whiteboard-core/sync-commands";
import { syncRoomIdFromWhiteboardRoomId } from "@orbmeet/whiteboard-core/whiteboard-room-id";
import {
  parseWhiteboardGrantPrincipalKey,
  whiteboardGrantPrincipalKey,
} from "@orbmeet/whiteboard-core/whiteboard-grant-principal";
import {
  areWhiteboardCapabilitiesStillAllowed,
  canAccessWhiteboardRoomAsRecorder,
  lookupWhiteboardSocketAccesses,
  resolveSoloWhiteboardEditor,
  type WhiteboardSocketAccessLookup,
} from "@/modules/whiteboards/server/meeting/access";
import { findWhiteboardIdForSyncRoom } from "@/modules/whiteboards/server/documents";
import { whiteboardCallbackKeyring, whiteboardCallbackNodeId } from "@/platform/realtime/nodes";
import { readSignedRequest } from "@/platform/http/internal-auth";
import { parseJsonObjectBody } from "@/platform/http/request-body";

/**
 * The sync server's view of D1 authority for one room.
 *
 * A room sends every distinct token claim it holds (live sockets plus an
 * admission in progress) and gets one verdict per claim. D1 stays the only
 * authority; the room holds no grants of its own and acts on these verdicts:
 *
 * - `active`  — the claim still matches current authority.
 * - `refresh` — the holder is still entitled to the room but the claim is
 *   stale: the document switched, a role, capability or grant changed, or the
 *   connection lease was replaced by a reconnect. The socket closes as
 *   transient and the client re-mints its token.
 * - `denied`  — no open Meeting stands behind the claim, or it resolves to
 *   somebody else. Terminal in the client, so it is reserved for verdicts a
 *   new token cannot change.
 *
 * A room names the board generation it holds, and every claim is `refresh`
 * once the board has moved on to another: its clients re-mint, and are sent
 * to the node holding it now.
 */

const MAX_AUTHORITY_BODY_BYTES = 512 * 1024;

export type WhiteboardAccessValidation =
  | { lookup: "unauthorized" }
  | { lookup: "retired" }
  | {
      lookup: "seated";
      identityStillAllowed: boolean;
      documentChanged: boolean;
      roleStillAllowed: boolean;
      capabilitiesStillAllowed: boolean;
    };

export function classifyWhiteboardAccessValidation(
  input: WhiteboardAccessValidation,
): AuthorityVerdict {
  if (input.lookup === "unauthorized") return "denied";
  if (input.lookup === "retired") return "refresh";
  // The lease resolved to a participant who is not this claim's subject. A new
  // token cannot make that true, so it is terminal rather than refreshable.
  if (!input.identityStillAllowed) return "denied";
  if (input.documentChanged || !input.roleStillAllowed || !input.capabilitiesStillAllowed) {
    return "refresh";
  }
  return "active";
}

function isAuthorityClaim(value: unknown): value is AuthorityClaim {
  if (!value || typeof value !== "object") return false;
  const claim = value as Record<string, unknown>;
  const capabilities = claim.capabilities as Record<string, unknown> | undefined;
  return (
    typeof claim.sub === "string" && claim.sub.length > 0 && claim.sub.length <= 256
    && (claim.role === "participant" || claim.role === "guest")
    && typeof claim.connectionId === "string" && claim.connectionId.length > 0
    && typeof claim.grantPrincipalKey === "string"
    && typeof capabilities?.canEditWhiteboard === "boolean"
    && typeof capabilities.canControlSurface === "boolean"
    && typeof capabilities.canManageWhiteboard === "boolean"
    && (claim.service === undefined || claim.service === "recorder" || claim.service === "solo")
    && (claim.documentId === undefined || typeof claim.documentId === "string")
  );
}

/**
 * The verdict for a service claim (solo editing or the recorder), or null for
 * a Meeting participant's claim, which {@link verdictsForClaims} answers in
 * one batch.
 */
async function serviceVerdict(
  db: Database,
  syncRoomId: string,
  claim: AuthorityClaim,
): Promise<AuthorityVerdict | null> {
  const principal = parseWhiteboardGrantPrincipalKey(claim.grantPrincipalKey);
  if (!principal) return "denied";
  const { capabilities } = claim;
  const documentId = claim.documentId?.trim() || undefined;

  // A solo editing session carries no Meeting binding at all: the verdict is
  // whether this user may still write to this Space's board.
  if (claim.service === "solo") {
    const board = await resolveSoloWhiteboardEditor(db, syncRoomId, claim.sub);
    const active = capabilities.canControlSurface === false
      && capabilities.canManageWhiteboard === false
      && capabilities.canEditWhiteboard === true
      && claim.role === "participant"
      && claim.connectionId === "solo"
      && principal.type === "user"
      && principal.id === claim.sub
      && Boolean(board)
      && (!documentId || board?.whiteboardId === documentId);
    return active ? "active" : "denied";
  }

  // The recorder holds only a room id; it is valid while that room's Meeting
  // is being recorded or streamed.
  if (claim.service === "recorder") {
    const currentDocumentId = documentId ? await findWhiteboardIdForSyncRoom(db, syncRoomId) : null;
    const active = claim.sub === "recorder"
      && claim.role === "guest"
      && !capabilities.canEditWhiteboard
      && !capabilities.canControlSurface
      && !capabilities.canManageWhiteboard
      && claim.connectionId === "recorder"
      && (!documentId || currentDocumentId === documentId)
      && await canAccessWhiteboardRoomAsRecorder(db, syncRoomId);
    return active ? "active" : "denied";
  }

  return null;
}

function participantVerdict(claim: AuthorityClaim, lookup: WhiteboardSocketAccessLookup): AuthorityVerdict {
  return classifyWhiteboardAccessValidation(
    lookup.status === "seated"
      ? {
          lookup: "seated",
          identityStillAllowed:
            lookup.access.participantIdentity === claim.sub
            && whiteboardGrantPrincipalKey(lookup.access.grantPrincipal) === claim.grantPrincipalKey,
          documentChanged: lookup.documentChanged,
          roleStillAllowed: claim.role === lookup.access.role,
          capabilitiesStillAllowed: areWhiteboardCapabilitiesStillAllowed(
            claim.capabilities,
            lookup.access.capabilities,
          ),
        }
      : { lookup: lookup.status },
  );
}

/** One verdict per claim a room holds, in order. */
async function verdictsForClaims(
  db: Database,
  syncRoomId: string,
  claims: readonly AuthorityClaim[],
): Promise<AuthorityVerdict[]> {
  const verdicts: Array<AuthorityVerdict | null> = [];
  // Service claims are one or two per room at most.
  for (const claim of claims) verdicts.push(await serviceVerdict(db, syncRoomId, claim));
  const participants = claims.flatMap((claim, index) => (verdicts[index] === null ? [{ claim, index }] : []));
  const lookups = await lookupWhiteboardSocketAccesses(
    db,
    syncRoomId,
    participants.map(({ claim }) => ({
      connectionId: claim.connectionId,
      documentId: claim.documentId?.trim() || undefined,
    })),
  );
  participants.forEach(({ claim, index }, position) => {
    verdicts[index] = participantVerdict(claim, lookups[position]);
  });
  return verdicts as AuthorityVerdict[];
}

export async function handleRoomAuthority(request: Request, env: Env): Promise<Response> {
  const signed = await readSignedRequest(request, callbackKeyring(env), MAX_AUTHORITY_BODY_BYTES);
  if (!signed.ok) return signed.response;
  // The key a node signs with names it.
  const nodeId = whiteboardCallbackNodeId(env, signed.keyId)!;

  const body = parseJsonObjectBody(signed.body);
  const syncRoomId = typeof body?.whiteboardRoomId === "string"
    ? syncRoomIdFromWhiteboardRoomId(body.whiteboardRoomId.trim())
    : null;
  const claims = body?.claims;
  if (
    !syncRoomId
    || !Array.isArray(claims)
    || claims.length === 0
    || claims.length > MAX_AUTHORITY_CLAIMS
    || !claims.every(isAuthorityClaim)
  ) {
    return new Response("Invalid payload", { status: 400 });
  }

  const generation = body?.generation;
  if (generation !== undefined && !(typeof generation === "number" && Number.isSafeInteger(generation) && generation >= 0)) {
    return new Response("Invalid payload", { status: 400 });
  }

  const db = createDb(env.DB);
  // A node the board is not on, or a room or token from a generation it has
  // moved on from: everyone re-mints, and the new token names the node
  // holding the board now. A node learns nothing of boards it does not hold.
  if (await boardIsElsewhere(db, syncRoomId, nodeId, generation)) {
    return Response.json({ verdicts: claims.map((): AuthorityVerdict => "refresh") });
  }
  const verdicts = await verdictsForClaims(db, syncRoomId, claims);
  return Response.json({ verdicts });
}

/** Whether the board is at another generation than `generation` now. A board with no row yet (one being created) has not moved. */
async function boardIsElsewhere(
  db: Database,
  syncRoomId: string,
  nodeId: string,
  generation: number | undefined,
): Promise<boolean> {
  const board = await db.query.whiteboards.findFirst({
    where: { syncRoomId },
    columns: { syncNodeId: true, syncGeneration: true },
  });
  if (!board) return false;
  return board.syncNodeId !== nodeId || (generation !== undefined && board.syncGeneration !== generation);
}

/** Every node's callback keys, or none when NODES is unusable, which refuses every call. */
function callbackKeyring(env: Env) {
  try {
    return whiteboardCallbackKeyring(env);
  } catch {
    return null;
  }
}
