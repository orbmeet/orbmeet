import type { IncomingMessage } from "node:http";
import {
  TLSyncErrorCloseEventReason,
} from "@tldraw/sync-core";
import {
  isTrustedProxyIp,
  resolveClientIp,
  type TrustedProxyMatcher,
} from "./net-security.ts";
import {
  verifyWhiteboardJWT,
  type WhiteboardJWTClaims,
} from "@orbmeet/whiteboard-core/whiteboard-jwt";
import type { SocketSession } from "../rooms/room-manager.ts";
import { header } from "./http.ts";
import { Reply } from "./reply.ts";
import { checkRequestOrigin } from "./config.ts";
import type { RateLimiter } from "../lib/rate-limiter.ts";
import type { AuthorityValidator } from "./authority-client.ts";
import { authorityClaimForToken } from "../rooms/room-authority.ts";
import type { Keyring } from "@orbmeet/primitives";
import { logWarn } from "../lib/log.ts";

/** The subprotocol a whiteboard client offers alongside its token, and the one the server accepts. */
export const SYNC_SUBPROTOCOL = "orbmeet-wb";

export type WsFatalCloseReason =
  | typeof TLSyncErrorCloseEventReason.NOT_AUTHENTICATED
  | typeof TLSyncErrorCloseEventReason.FORBIDDEN
  | typeof TLSyncErrorCloseEventReason.RATE_LIMITED
  | typeof TLSyncErrorCloseEventReason.UNKNOWN_ERROR;

interface SocketAdmissionOptions {
  allowedOrigins: string[];
  allowInsecureAllOrigins: boolean;
  trustedProxyIps: TrustedProxyMatcher[];
  ipRateLimiter: Pick<RateLimiter, "check">;
  jwtKeyring: Keyring;
  authority: AuthorityValidator;
}

/**
 * What to do with a WebSocket upgrade request.
 *
 * `refused` answers over plain HTTP, without a handshake. `rejected` completes
 * the handshake only to close the socket with a tldraw close reason: a browser
 * cannot read the status of a failed upgrade, so the close reason is the only
 * way to tell the client to refresh its token rather than retry. `admitted`
 * carries the session the socket will join its room as.
 */
export type SocketAdmission =
  | { type: "refused"; reply: Reply }
  | { type: "rejected"; reason: WsFatalCloseReason }
  | { type: "admitted"; session: SocketSession };

function getWebSocketAuthToken(req: IncomingMessage): string | null {
  const protocols = header(req, "Sec-WebSocket-Protocol");
  return protocols
    ? (
      protocols
        .split(",")
        .map((protocol) => protocol.trim())
        .find((protocol) => protocol && protocol !== SYNC_SUBPROTOCOL) ?? null
    )
    : null;
}

function claimsSession(claims: WhiteboardJWTClaims): SocketSession {
  return {
    tldrawSessionId: `${claims.sub}:${crypto.randomUUID()}`,
    userId: claims.sub,
    userName: claims.name,
    role: claims.role,
    capabilities: claims.capabilities,
    grantPrincipal: claims.grantPrincipal,
    whiteboardRoomId: claims.sid,
    connectionId: claims.connectionId,
    service: claims.service,
    documentId: claims.documentId,
    generation: claims.generation,
    tokenExpiresAt: claims.exp * 1000,
    tokenIssuedAt: claims.iat * 1000,
  };
}

/** The address a request's rate limits are charged to: the client behind a trusted proxy, else the peer. */
export function resolveRateLimitIp(
  req: IncomingMessage,
  trustedProxyIps: TrustedProxyMatcher[],
): string {
  const connectingIp = req.socket.remoteAddress ?? "unknown";
  if (
    trustedProxyIps.length > 0 &&
    isTrustedProxyIp(connectingIp, trustedProxyIps)
  ) {
    return resolveClientIp(
      header(req, "X-Forwarded-For"),
      connectingIp,
      trustedProxyIps,
    );
  }
  return connectingIp;
}

/**
 * Decide a WebSocket upgrade: rate, origin, token, and a fresh authority
 * verdict. Opening the room is left to the caller, in the same synchronous
 * turn as the handshake, so nothing can close it in between.
 */
export async function admitWhiteboardSocket(
  req: IncomingMessage,
  {
    allowedOrigins,
    allowInsecureAllOrigins,
    trustedProxyIps,
    ipRateLimiter,
    jwtKeyring,
    authority,
  }: SocketAdmissionOptions,
): Promise<SocketAdmission> {
  const origin = header(req, "Origin");
  const clientIp = resolveRateLimitIp(req, trustedProxyIps);

  if (!ipRateLimiter.check(clientIp)) {
    logWarn(
      `[ws] rate-limited ip=${clientIp} origin=${origin ?? "unknown"}`,
    );
    // Rate limiting is an HTTP admission decision. Do not spend a WebSocket
    // upgrade, socket slot, and close handshake merely to carry the same fact.
    return {
      type: "refused",
      reply: Reply.json({ error: "Too many connection attempts" }, 429, { "Retry-After": "1" }),
    };
  }

  const originRejection = checkRequestOrigin(origin, {
    allowedOrigins,
    allowInsecureAllOrigins,
  });
  if (originRejection) {
    logWarn(
      `[ws] rejected ${originRejection} origin=${origin ?? "unknown"}`,
    );
    return { type: "rejected", reason: TLSyncErrorCloseEventReason.FORBIDDEN };
  }

  const token = getWebSocketAuthToken(req);
  if (!token) {
    const hasQueryToken = new URL(req.url ?? "/", "http://localhost").searchParams.has("token");
    logWarn(
      `[ws] rejected missing token origin=${origin} hasQueryToken=${hasQueryToken}`,
    );
    return { type: "rejected", reason: TLSyncErrorCloseEventReason.NOT_AUTHENTICATED };
  }

  let claims: WhiteboardJWTClaims;
  try {
    claims = await verifyWhiteboardJWT(token, jwtKeyring);
  } catch {
    logWarn(`[ws] rejected invalid token origin=${origin}`);
    return { type: "rejected", reason: TLSyncErrorCloseEventReason.NOT_AUTHENTICATED };
  }

  // One fresh verdict per admission. After admission the room's own sweep
  // keeps re-verifying the socket.
  const verdictResult = await authority.verdicts(claims.sid, [authorityClaimForToken(claims)], claims.generation);
  const verdict = verdictResult === "unavailable" ? verdictResult : verdictResult[0];
  if (verdict !== "active") {
    logWarn(`[ws] rejected ${verdict} sub=${claims.sub} sid=${claims.sid}`);
    return {
      type: "rejected",
      reason: verdict === "denied"
        ? TLSyncErrorCloseEventReason.FORBIDDEN
        : verdict === "refresh"
          ? TLSyncErrorCloseEventReason.NOT_AUTHENTICATED
          : TLSyncErrorCloseEventReason.UNKNOWN_ERROR,
    };
  }

  return { type: "admitted", session: claimsSession(claims) };
}
