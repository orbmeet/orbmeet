import { SIGNATURE_HEADER, verifySignedRequest, type Keyring } from "@orbmeet/primitives";
import {
  verifyWhiteboardJWT,
  type WhiteboardJWTClaims,
} from "@orbmeet/whiteboard-core/whiteboard-jwt";
import type { AuthorityValidator } from "../http/authority-client.ts";
import { authorityClaimForToken } from "../rooms/room-authority.ts";
import type { RoomManager } from "../rooms/room-manager.ts";
import type { IncomingMessage } from "node:http";
import { header, parseJsonObject, readBoundedBody } from "../http/http.ts";
import { Reply } from "../http/reply.ts";
import { logWarn } from "../lib/log.ts";

/**
 * Centralized request authentication policies.
 *
 * Browser routes carry a whiteboard JWT; Worker commands carry a signature
 * from the command keyring. Each route names its policy here instead of
 * re-deriving that choreography.
 */

export type JWTClaims = WhiteboardJWTClaims;

export type AuthResult =
  | { ok: true; claims: WhiteboardJWTClaims }
  | { ok: false; reply: Reply };

/**
 * `live` asks the Worker for a fresh verdict on every request (used where a
 * mutation must reflect a revocation that just happened). `session` accepts a
 * token whose exact claims belong to a socket the room is already keeping
 * verified, and falls back to a live verdict otherwise.
 */
export type AccessValidationMode = "live" | "session";

/** Commands carry larger bodies than browser JSON. */
const MAX_COMMAND_BODY_BYTES = 256 * 1024;

function bearerToken(req: IncomingMessage): string | null {
  const authHeader = header(req, "Authorization");
  return authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
}

export class RequestAuth {
  private readonly jwtKeyring: Keyring;
  private readonly commandKeyring: Keyring;
  private readonly authority: AuthorityValidator;
  private readonly roomManager: RoomManager;

  constructor(
    jwtKeyring: Keyring,
    commandKeyring: Keyring,
    authority: AuthorityValidator,
    roomManager: RoomManager,
  ) {
    this.jwtKeyring = jwtKeyring;
    this.commandKeyring = commandKeyring;
    this.authority = authority;
    this.roomManager = roomManager;
  }

  /**
   * Reject non-JSON content types up front to prevent CSRF via content-type
   * sniffing. Returns the 415 reply, or null when the request may proceed.
   */
  requireJsonContentType(req: IncomingMessage): Reply | null {
    const contentType = header(req, "Content-Type");
    if (!contentType || !contentType.includes("application/json")) {
      return Reply.json({ error: "Content-Type must be application/json" }, 415);
    }
    return null;
  }

  async authenticateBearer(
    req: IncomingMessage,
    mode: AccessValidationMode = "session",
  ): Promise<AuthResult> {
    const token = bearerToken(req);
    if (token === null) {
      return { ok: false, reply: Reply.text("Unauthorized", 401) };
    }
    let claims: WhiteboardJWTClaims;
    try {
      claims = await verifyWhiteboardJWT(token, this.jwtKeyring);
    } catch {
      return { ok: false, reply: Reply.text("Invalid token", 401) };
    }
    const claim = authorityClaimForToken(claims);
    const room = mode === "session" ? this.roomManager.getRoomIfExists(claims.sid) : null;
    // A token minted for another generation of the board is the Worker's to judge.
    if (
      room?.authority.holdsVerifiedClaim(claim)
      && (claims.generation === undefined || claims.generation === room.document.generation)
    ) {
      return { ok: true, claims };
    }
    const verdicts = await this.authority.verdicts(claims.sid, [claim], claims.generation);
    if (verdicts === "unavailable") {
      return { ok: false, reply: Reply.text("Whiteboard auth unavailable", 503) };
    }
    if (verdicts[0] !== "active") {
      return { ok: false, reply: Reply.text("Token no longer valid for this meeting", 401) };
    }
    return { ok: true, claims };
  }

  /** Read and verify a signed Worker command; returns its parsed body. */
  async readCommand(
    req: IncomingMessage,
    url: URL,
  ): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; reply: Reply }> {
    let bytes: Buffer<ArrayBuffer>;
    try {
      bytes = await readBoundedBody(req, MAX_COMMAND_BODY_BYTES);
    } catch (error) {
      const tooLarge = error instanceof Error && error.message === "payload_too_large";
      return {
        ok: false,
        reply: tooLarge ? Reply.text("Payload too large", 413) : Reply.text("Bad request", 400),
      };
    }
    const verification = await verifySignedRequest({
      header: header(req, SIGNATURE_HEADER),
      method: req.method ?? "",
      target: `${url.pathname}${url.search}`,
      body: bytes,
      keyring: this.commandKeyring,
    });
    if (!verification.ok) {
      logWarn(`[commands] rejected ${url.pathname}: ${verification.reason}`);
      return { ok: false, reply: Reply.text("Unauthorized", 401) };
    }
    try {
      return { ok: true, body: parseJsonObject<Record<string, unknown>>(bytes) };
    } catch {
      return { ok: false, reply: Reply.text("Invalid JSON", 400) };
    }
  }
}
