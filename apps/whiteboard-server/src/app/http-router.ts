import type { IncomingMessage } from "node:http";
import {
  handlePdfImportCancel,
  handlePdfImportStart,
  handlePdfImportStatus,
} from "../pdf/pdf-import.ts";
import { parsePdfImportPath } from "../pdf/pdf-import-contract.ts";
import { WHITEBOARD_SYNC_ROUTES } from "@orbmeet/whiteboard-core/protocol";
import { AssistantRequestSchema, MAX_ASSISTANT_REQUEST_BYTES } from "@orbmeet/whiteboard-core/assistant";
import * as v from "valibot";
import { header, jsonBodyErrorReply, readBoundedJson } from "../http/http.ts";
import { Reply } from "../http/reply.ts";
import { checkRequestOrigin, type OriginPolicy } from "../http/config.ts";
import { handleUnfurl } from "../http/unfurl.ts";
import { dispatchSyncCommand, syncCommandReply } from "../http/commands.ts";
import {
  acceptsSyncProtocol,
  parseSyncCommandPath,
  SYNC_PROTOCOL,
  SYNC_PROTOCOL_HEADER,
  syncCommandFailure,
  syncProtocolOf,
  type SyncHealth,
} from "@orbmeet/whiteboard-core/sync-commands";
import type { Keyring } from "@orbmeet/primitives";
import { resolveRateLimitIp } from "../http/socket-admission.ts";
import type { TrustedProxyMatcher } from "../http/net-security.ts";
import type { RateLimiter } from "../lib/rate-limiter.ts";
import type { AuthorityValidator } from "../http/authority-client.ts";
import type { RoomManager } from "../rooms/room-manager.ts";
import type { R2UploadConfig } from "../pdf/pdf-import-jobs.ts";
import { RequestAuth, type JWTClaims } from "./request-auth.ts";

/** The fixed-window limiter shape the router and shutdown sequence share. */
export interface HttpRouterDeps {
  appUrl: string;
  callbackKeyring: Keyring;
  jwtKeyring: Keyring;
  pdfImportR2Config: R2UploadConfig;
  originPolicy: OriginPolicy;
  trustedProxyIps: TrustedProxyMatcher[];
  roomManager: RoomManager;
  authority: AuthorityValidator;
  auth: RequestAuth;
  cors: {
    corsHeaders(req: IncomingMessage): Record<string, string>;
    withCors(reply: Reply, req: IncomingMessage): Reply;
  };
  rateLimiters: {
    /** Per-IP connection budget for the WebSocket upgrade. */
    socketAdmission: RateLimiter;
    /** Isolated so uptime probes can never consume the admission budget. */
    health: RateLimiter;
    /** Shared bucket for the browser-called JWT routes. */
    publicHttp: RateLimiter;
    /** Per-user budget layered on top of the public bucket for /unfurl. */
    unfurl: RateLimiter;
  };
  isShuttingDown(): boolean;
}

function pdfGrantContext(deps: HttpRouterDeps, claims: JWTClaims) {
  return {
    meetingSid: claims.sid,
    connectionId: claims.connectionId,
    participantIdentity: claims.sub,
    appUrl: deps.appUrl,
    callbackKeyring: deps.callbackKeyring,
  };
}

/**
 * The PDF import routes. Browser-called and JWT authenticated: starting one
 * needs edit access to the open room; reading or cancelling one needs to be
 * the participant who started it.
 */
async function handlePdfRoute(
  req: IncomingMessage,
  url: URL,
  route: NonNullable<ReturnType<typeof parsePdfImportPath>>,
  deps: HttpRouterDeps,
  claims: JWTClaims,
): Promise<Reply> {
  const grant = pdfGrantContext(deps, claims);
  if (route.type === "start") {
    const room = deps.roomManager.getRoomIfExists(claims.sid);
    if (!room?.canUserAddPages(claims.sub)) {
      return Reply.json({ error: "Whiteboard edit access is required" }, 403);
    }
    return handlePdfImportStart(req, url, grant, {
      r2Config: deps.pdfImportR2Config,
      findRoom: () => deps.roomManager.getRoomIfExists(claims.sid),
    });
  }
  if (req.method === "GET") return handlePdfImportStatus(route.id, grant);
  if (req.method === "DELETE") return handlePdfImportCancel(route.id, claims.sub, claims.sid);
  return Reply.text("Method not allowed", 405);
}

/**
 * The whiteboard sync HTTP surface: browser-facing JWT routes and the
 * Worker's signed commands. The WebSocket route is an upgrade, which the
 * gateway answers (`ws-gateway.ts`).
 *
 * Routing only decides *which* policy applies; the policies themselves (JWT +
 * authority verdict, command signature, origin admission, content-type) live in
 * `request-auth.ts`, and the room/document behaviour lives behind RoomManager
 * and Room. The answer is a Reply; the server writes it.
 */
export function createHttpRequestHandler(deps: HttpRouterDeps) {
  const { auth, cors } = deps;

  return async function handleHttpRequest(req: IncomingMessage): Promise<Reply> {
    if (deps.isShuttingDown()) {
      return Reply.text("Service shutting down", 503);
    }
    const url = new URL(req.url ?? "/", "http://localhost");

    // Handle CORS preflight for all non-WebSocket endpoints
    if (req.method === "OPTIONS") {
      return Reply.empty(204, cors.corsHeaders(req));
    }

    // Only reached without an upgrade: the gateway answers every upgrade.
    if (url.pathname === WHITEBOARD_SYNC_ROUTES.connect) {
      return Reply.text("Upgrade Required", 426, { Upgrade: "websocket" });
    }

    // Health check — only expose basic status, not room count
    if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/health") {
      const clientIp = resolveRateLimitIp(req, deps.trustedProxyIps);
      if (!deps.rateLimiters.health.check(clientIp)) {
        return Reply.text("Too many requests", 429);
      }
      // HEAD gets the same headers, without the body. The protocol range is
      // how the Worker knows it can send this node commands at all.
      return Reply.json({ ok: true, protocol: SYNC_PROTOCOL } satisfies SyncHealth);
    }

    const pdfRoute = parsePdfImportPath(url.pathname);
    if (
      url.pathname === WHITEBOARD_SYNC_ROUTES.unfurl ||
      url.pathname === WHITEBOARD_SYNC_ROUTES.assistant ||
      pdfRoute
    ) {
      const clientIp = resolveRateLimitIp(req, deps.trustedProxyIps);
      if (!deps.rateLimiters.publicHttp.check(clientIp)) {
        return cors.withCors(Reply.text("Too many requests", 429), req);
      }
    }

    // URL unfurling for bookmark shapes — JWT authenticated
    if (req.method === "POST" && url.pathname === WHITEBOARD_SYNC_ROUTES.unfurl) {
      const contentTypeRejection = auth.requireJsonContentType(req);
      if (contentTypeRejection) return cors.withCors(contentTypeRejection, req);

      const result = await auth.authenticateBearer(req, "session");
      if (!result.ok) return cors.withCors(result.reply, req);
      if (!deps.rateLimiters.unfurl.check(result.claims.sub)) {
        return cors.withCors(Reply.text("Too many requests", 429), req);
      }
      return cors.withCors(await handleUnfurl(req), req);
    }

    // The board assistant: GET reads the conversation, POST makes a request.
    if (req.method === "GET" && url.pathname === WHITEBOARD_SYNC_ROUTES.assistant) {
      const result = await auth.authenticateBearer(req, "session");
      if (!result.ok) return cors.withCors(result.reply, req);
      const room = deps.roomManager.getRoomIfExists(result.claims.sid);
      if (!room) return cors.withCors(Reply.json({ error: "Room not found" }, 404), req);
      // Each person reads the room's conversation and their own private ones.
      return cors.withCors(Reply.json(room.assistant.snapshot(result.claims.sub)), req);
    }

    if (req.method === "POST" && url.pathname === WHITEBOARD_SYNC_ROUTES.assistant) {
      const contentTypeRejection = auth.requireJsonContentType(req);
      if (contentTypeRejection) return cors.withCors(contentTypeRejection, req);
      const originRejection = checkRequestOrigin(header(req, "Origin"), deps.originPolicy);
      if (originRejection) {
        return cors.withCors(Reply.text("Forbidden origin", 403), req);
      }
      const result = await auth.authenticateBearer(req, "live");
      if (!result.ok) return cors.withCors(result.reply, req);
      const { claims } = result;

      let body: unknown;
      try {
        body = await readBoundedJson<unknown>(req, MAX_ASSISTANT_REQUEST_BYTES);
      } catch (error) {
        return cors.withCors(jsonBodyErrorReply(error), req);
      }
      const request = v.safeParse(AssistantRequestSchema, body);
      if (!request.success) {
        return cors.withCors(Reply.json({ error: "Invalid assistant request" }, 400), req);
      }
      const room = deps.roomManager.getRoomIfExists(claims.sid);
      if (!room) return cors.withCors(Reply.json({ error: "Room not found" }, 404), req);
      const sender = { userId: claims.sub, userName: claims.name, connectionId: claims.connectionId };
      return cors.withCors(room.assistant.handle(sender, request.output), req);
    }

    if (pdfRoute) {
      const result = await auth.authenticateBearer(req, "session");
      if (!result.ok) return cors.withCors(result.reply, req);
      return cors.withCors(await handlePdfRoute(req, url, pdfRoute, deps, result.claims), req);
    }

    // Worker commands — signed with the command keyring.
    const command = req.method === "POST" ? parseSyncCommandPath(url.pathname) : null;
    if (command) {
      const read = await auth.readCommand(req, url);
      if (!read.ok) return read.reply;
      const spoken = syncProtocolOf(header(req, SYNC_PROTOCOL_HEADER));
      if (!acceptsSyncProtocol(SYNC_PROTOCOL, spoken)) {
        return syncCommandReply(syncCommandFailure(
          "incompatible",
          `This node accepts sync protocol ${SYNC_PROTOCOL.accepts.oldest}–${SYNC_PROTOCOL.accepts.newest}, not ${spoken ?? "an unreadable version"}`,
        ));
      }
      return syncCommandReply(await dispatchSyncCommand(command, read.body, deps.roomManager));
    }

    return Reply.text("Not found", 404);
  };
}
