import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { RoomCapacityError, RoomManagerUnavailableError } from "../rooms/room-manager-types.ts";
import { RoomManager } from "../rooms/room-manager.ts";
import { createAuthorityClient, type AuthorityValidator } from "../http/authority-client.ts";
import {
  createFileObjectStore,
  createR2ObjectStore,
  type ObjectStore,
} from "../persistence/r2.ts";
import { RateLimiter } from "../lib/rate-limiter.ts";
import { createCorsHelpers } from "../http/http.ts";
import { Reply, sendReply } from "../http/reply.ts";
import { admitWhiteboardSocket } from "../http/socket-admission.ts";
import { initializePdfRenderScratchDir } from "../pdf/pdf-import-jobs.ts";
import { stopPdfImportCleanup } from "../pdf/pdf-import.ts";
import type { WhiteboardServerConfig } from "../http/config.ts";
import { createHttpRequestHandler, type HttpRouterDeps } from "./http-router.ts";
import { RequestAuth } from "./request-auth.ts";
import { createWebSocketGateway } from "./ws-gateway.ts";
import { createAssistantModel } from "../assistant/assistant-model.ts";
import { logError, logInfo } from "../lib/log.ts";

/**
 * The whiteboard sync application: composition and lifecycle.
 *
 * Everything the process needs is constructed here with the loaded config
 * injected — the object store, the authority client, the room manager, the
 * rate-limit buckets, the request policy, the request router, and the
 * WebSocket gateway — around one `node:http` server. The entrypoint only
 * loads config, starts the app, and listens; tests listen on a free port and
 * talk to it with `fetch` and `WebSocket`.
 */
export class WhiteboardSyncApp {
  readonly roomManager: RoomManager;
  readonly authority: AuthorityValidator;
  private readonly rateLimiters: HttpRouterDeps["rateLimiters"];
  private readonly handleHttpRequest: ReturnType<typeof createHttpRequestHandler>;
  private readonly websocket: ReturnType<typeof createWebSocketGateway>;
  readonly server: Server;
  private shuttingDown = false;
  private shutdownDone: Promise<void> | null = null;

  private readonly config: WhiteboardServerConfig;

  constructor(
    config: WhiteboardServerConfig,
    options: {
      onWriterLockLost?: () => void;
      /** Test seams; production builds them from the config. */
      authority?: AuthorityValidator;
      objects?: ObjectStore;
    } = {},
  ) {
    this.config = config;
    const {
      dataDir,
      callbackKeyring,
      commandKeyring,
      jwtKeyring,
      allowedOrigins,
      allowInsecureAllOrigins,
      ipRateLimit,
      ipRateWindowMs,
      ipRateMaxKeys,
    } = config;

    const onWriterLockLost =
      options.onWriterLockLost ??
      (() => {
        // Losing the single-writer lock means another process may now own the
        // data dir; continuing risks split-brain writes. Exit so the supervisor
        // restarts us and we re-acquire the lock from on-disk state. Defer so the
        // throwing caller can unwind first — RoomManager already fails new work
        // closed.
        logError("[whiteboard-server] FATAL: writer lock lost, exiting");
        setTimeout(() => process.exit(1), 0).unref?.();
      });

    this.authority =
      options.authority ?? createAuthorityClient({ appUrl: config.appUrl, keyring: callbackKeyring });
    const objects =
      options.objects
      ?? (config.developmentObjectStoreDir
        ? createFileObjectStore(config.developmentObjectStoreDir)
        : createR2ObjectStore(config.r2Config));

    this.roomManager = new RoomManager(dataDir, {
      objects,
      authority: this.authority,
      onWriterLockLost,
      assistantModel: config.assistant ? createAssistantModel(config.assistant) : null,
    });

    this.rateLimiters = {
      // Per-IP connection rate limiter.
      socketAdmission: new RateLimiter(ipRateLimit, ipRateWindowMs, { maxKeys: ipRateMaxKeys }),
      // /health gets its own bucket so load-balancer or uptime probes sharing
      // an IP with the reverse proxy can never consume the WebSocket admission
      // budget.
      health: new RateLimiter(120, 60_000),
      publicHttp: new RateLimiter(300, 60_000, { maxKeys: ipRateMaxKeys }),
      unfurl: new RateLimiter(10, 10_000, { maxKeys: ipRateMaxKeys }),
    };

    const auth = new RequestAuth(jwtKeyring, commandKeyring, this.authority, this.roomManager);

    this.handleHttpRequest = createHttpRequestHandler({
      appUrl: config.appUrl,
      callbackKeyring,
      jwtKeyring,
      pdfImportR2Config: config.r2Config,
      originPolicy: { allowedOrigins, allowInsecureAllOrigins },
      trustedProxyIps: config.trustedProxyIps,
      roomManager: this.roomManager,
      authority: this.authority,
      auth,
      cors: createCorsHelpers({ allowedOrigins, allowInsecureAllOrigins }),
      rateLimiters: this.rateLimiters,
      isShuttingDown: () => this.shuttingDown,
    });

    this.websocket = createWebSocketGateway({
      roomManager: this.roomManager,
      isShuttingDown: () => this.shuttingDown,
      admit: (req) => admitWhiteboardSocket(req, {
        allowedOrigins,
        allowInsecureAllOrigins,
        trustedProxyIps: config.trustedProxyIps,
        ipRateLimiter: this.rateLimiters.socketAdmission,
        jwtKeyring,
        authority: this.authority,
      }),
    });

    // Long enough for the slowest body a route accepts (a PDF upload's
    // five-minute read deadline) to be refused by the route itself.
    this.server = createServer({ requestTimeout: 6 * 60_000 }, (req, res) => void this.respond(req, res));
    this.server.on("upgrade", (req, socket, head) => void this.websocket.handleUpgrade(req, socket, head));
  }

  /**
   * Recovery that must run before the surface accepts work. Split from the
   * constructor so tests can construct the app without side effects on shared
   * recovery state.
   */
  async start(): Promise<void> {
    await initializePdfRenderScratchDir();
    // Whatever an earlier run left unsaved goes to R2, in the background: a
    // board is served from its database here meanwhile, and a node taking it
    // over later starts from the copy.
    void this.roomManager.saveAllRooms();
  }

  /** Bind the HTTP/WebSocket surface; `port` 0 picks a free one. */
  async listen(port = this.config.port, host = "0.0.0.0"): Promise<AddressInfo> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, host, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    const address = this.server.address() as AddressInfo;
    logInfo(`[whiteboard-server] Listening on port ${address.port}`);
    return address;
  }

  private async respond(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let reply: Reply;
    try {
      reply = await this.handleHttpRequest(req);
    } catch (error) {
      reply = this.renderError(error);
    }
    if (!res.destroyed) sendReply(req, res, reply);
  }

  private renderError(error: unknown): Reply {
    logError("[whiteboard-server] Unhandled request error:", error);
    if (error instanceof RoomManagerUnavailableError || error instanceof RoomCapacityError) {
      return Reply.text("Whiteboard temporarily unavailable", 503);
    }
    return Reply.text("Internal server error", 500);
  }

  /**
   * Graceful shutdown: stop admitting work, stop background timers, close the
   * listener, ask every client to reconnect, then close every room.
   * Idempotent; a second call returns the first one's completion.
   */
  shutdown(signal: string): Promise<void> {
    if (this.shutdownDone) return this.shutdownDone;
    this.shuttingDown = true;
    logInfo(`[whiteboard-server] ${signal} received, shutting down`);
    this.rateLimiters.socketAdmission.destroy();
    this.rateLimiters.health.destroy();
    this.rateLimiters.publicHttp.destroy();
    this.rateLimiters.unfurl.destroy();
    stopPdfImportCleanup();
    this.roomManager.beginShutdown();

    const hardExit = setTimeout(() => {
      logError("[whiteboard-server] Graceful shutdown exceeded 110 seconds, forcing exit");
      process.exit(1);
    }, 110_000);
    hardExit.unref?.();

    this.shutdownDone = (async () => {
      // New requests are refused with a 503 from here on; ones in flight
      // finish, and idle keep-alive connections are let go now.
      const closed = this.server.listening
        ? new Promise<void>((resolve) => this.server.close(() => resolve()))
        : Promise.resolve();
      this.server.closeIdleConnections();
      this.websocket.closeAll(1012, "server restarting");

      try {
        await this.roomManager.closeAll();
      } catch (error) {
        logError(
          "[whiteboard-server] Failed to close whiteboard rooms during shutdown:",
          error,
        );
        process.exitCode = 1;
      } finally {
        this.websocket.terminateAll();
        this.server.closeAllConnections();
        await closed;
        clearTimeout(hardExit);
      }
    })();
    return this.shutdownDone;
  }
}
