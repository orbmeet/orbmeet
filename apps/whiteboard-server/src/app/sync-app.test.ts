import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import * as syncCore from "@tldraw/sync-core";
import { TLSyncErrorCloseEventCode, TLSyncErrorCloseEventReason } from "@tldraw/sync-core";
import { whiteboardTLSchema } from "@orbmeet/whiteboard-core/room-schema";
import { createWhiteboardJWT } from "@orbmeet/whiteboard-core/whiteboard-jwt";
import { SIGNATURE_HEADER, signRequest } from "@orbmeet/primitives";
import { SYNC_PROTOCOL, SYNC_PROTOCOL_HEADER } from "@orbmeet/whiteboard-core/sync-commands";
import { whiteboardRevisionKey } from "@orbmeet/whiteboard-core/document-keys";
import { WhiteboardSyncApp } from "./sync-app.ts";
import type { WhiteboardServerConfig } from "../http/config.ts";
import type { AuthorityValidator } from "../http/authority-client.ts";
import { createMemoryObjectStore } from "../persistence/r2.ts";
import { WHITEBOARD_CONFIG } from "@orbmeet/whiteboard-core/config";
import type { WhiteboardRoomId } from "@orbmeet/whiteboard-core/whiteboard-room-id";
import { fakeAuthority } from "../rooms/room-test-support.ts";
import { TEST_CALLBACK_KEYRING, TEST_COMMAND_KEYRING, TEST_JWT_KEYRING } from "../http/test-keyrings.ts";

/**
 * Drives the composed application over real HTTP and WebSocket connections on
 * a free port: routing, auth choreography, and what is actually written to
 * the wire.
 */

// Runtime protocol helper is marked internal and omitted from published types.
const { getTlsyncProtocolVersion } = syncCore as unknown as { getTlsyncProtocolVersion(): number };

function makeConfig(dataDir: string): WhiteboardServerConfig {
  return {
    port: 0,
    dataDir,
    appUrl: "https://app.example",
    commandKeyring: TEST_COMMAND_KEYRING,
    callbackKeyring: TEST_CALLBACK_KEYRING,
    jwtKeyring: TEST_JWT_KEYRING,
    r2Config: {
      accessKeyId: "",
      secretAccessKey: "",
      accountId: "",
      bucketName: "",
    },
    developmentObjectStoreDir: null,
    allowedOrigins: ["https://meet.example"],
    allowInsecureAllOrigins: false,
    trustedProxyIps: [],
    ipRateLimit: 60,
    ipRateWindowMs: 60_000,
    ipRateMaxKeys: 50_000,
    assistant: null,
  };
}

const origins = new WeakMap<WhiteboardSyncApp, Promise<string>>();

/** Where `app` listens, starting it on a free port the first time. */
function originOf(app: WhiteboardSyncApp): Promise<string> {
  let origin = origins.get(app);
  if (!origin) {
    origin = app.listen(0, "127.0.0.1").then(({ port }) => `127.0.0.1:${port}`);
    origins.set(app, origin);
  }
  return origin;
}

/** Send `req`, addressed to any host, to the app instead. */
async function fetchRequired(app: WhiteboardSyncApp, req: Request): Promise<Response> {
  const { pathname, search } = new URL(req.url);
  return fetch(`http://${await originOf(app)}${pathname}${search}`, {
    method: req.method,
    headers: req.headers,
    body: req.body ? await req.arrayBuffer() : undefined,
  });
}

/** Open a sync socket the way the whiteboard client does, and wait for it to open or close. */
async function connect(app: WhiteboardSyncApp, token: string, origin = "https://meet.example") {
  const ws = new WebSocket(`ws://${await originOf(app)}/connect`, [token, "orbmeet-wb"], { origin });
  ws.on("error", () => {});
  const closed = once(ws, "close").then(([code, reason]) => ({ code: code as number, reason: String(reason) }));
  const outcome = await Promise.race([once(ws, "open").then(() => "open" as const), closed.then(() => "closed" as const)]);
  return { ws, outcome, closed };
}

const dataDirs: string[] = [];
const apps: WhiteboardSyncApp[] = [];

function makeApp(
  authority: AuthorityValidator = fakeAuthority(),
  objects = createMemoryObjectStore(),
  overrides: Partial<WhiteboardServerConfig> = {},
): WhiteboardSyncApp {
  const dataDir = mkdtempSync(join(tmpdir(), "wb-sync-app-"));
  dataDirs.push(dataDir);
  const app = new WhiteboardSyncApp({ ...makeConfig(dataDir), ...overrides }, { authority, objects });
  apps.push(app);
  return app;
}

async function signedCommand(
  path: string,
  body: unknown,
  keyring = TEST_COMMAND_KEYRING,
  headers: Record<string, string> = {},
) {
  const text = JSON.stringify(body);
  return new Request(`https://sync.example${path}`, {
    method: "POST",
    headers: {
      ...headers,
      "Content-Type": "application/json",
      [SIGNATURE_HEADER]: await signRequest({ method: "POST", target: path, body: text, keyring }),
    },
    body: text,
  });
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.shutdown("test")));
  for (const dir of dataDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("WhiteboardSyncApp request handler", () => {
  it("answers health checks without exposing room state", async () => {
    const app = makeApp();
    const response = await fetchRequired(
      app,
      new Request("https://sync.example/health"),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, protocol: SYNC_PROTOCOL });
  });

  it("preflights CORS and applies security headers", async () => {
    const app = makeApp();
    const response = await fetchRequired(
      app,
      new Request("https://sync.example/assistant", {
        method: "OPTIONS",
        headers: { Origin: "https://meet.example" },
      }),
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://meet.example");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("enforces the assistant request policy chain: content type, origin, then token", async () => {
    const app = makeApp();

    const notJson = await fetchRequired(
      app,
      new Request("https://sync.example/assistant", {
        method: "POST",
        headers: { Origin: "https://meet.example", "Content-Type": "text/plain" },
      }),
    );
    expect(notJson.status).toBe(415);

    const foreignOrigin = await fetchRequired(
      app,
      new Request("https://sync.example/assistant", {
        method: "POST",
        headers: {
          Origin: "https://evil.example",
          "Content-Type": "application/json",
          Authorization: `Bearer ${await mintToken()}`,
        },
      }),
    );
    expect(foreignOrigin.status).toBe(403);

    const missingOrigin = await fetchRequired(
      app,
      new Request("https://sync.example/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(missingOrigin.status).toBe(403);

    const noToken = await fetchRequired(
      app,
      new Request("https://sync.example/assistant", {
        method: "POST",
        headers: { Origin: "https://meet.example", "Content-Type": "application/json" },
      }),
    );
    expect(noToken.status).toBe(401);
  });

  it("validates the bearer token's authority live before acting", async () => {
    const ask = async (app: WhiteboardSyncApp) =>
      fetchRequired(
        app,
        new Request("https://sync.example/assistant", {
          method: "POST",
          headers: {
            Origin: "https://meet.example",
            "Content-Type": "application/json",
            Authorization: `Bearer ${await mintToken()}`,
          },
          body: JSON.stringify({ kind: "not-a-request" }),
        }),
      );

    expect((await ask(makeApp(fakeAuthority("denied")))).status).toBe(401);
    expect((await ask(makeApp(fakeAuthority("unavailable")))).status).toBe(503);
    // An invalid body is refused only after the whole auth chain has passed.
    expect((await ask(makeApp(fakeAuthority("active")))).status).toBe(400);
  });

  it("accepts only commands signed with the command keyring", async () => {
    const app = makeApp();

    const unsigned = await fetchRequired(
      app,
      new Request("https://sync.example/commands/capture", { method: "POST", body: "{}" }),
    );
    expect(unsigned.status).toBe(401);

    // The callback keyring is the other direction's key: it must not work here.
    const wrongDirection = await fetchRequired(
      app,
      await signedCommand("/commands/capture", {}, TEST_CALLBACK_KEYRING),
    );
    expect(wrongDirection.status).toBe(401);

    const malformed = await fetchRequired(app, await signedCommand("/commands/capture", {}));
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ ok: false, reason: "invalid" });

    const unknown = await fetchRequired(app, await signedCommand("/commands/nope", {}));
    expect(unknown.status).toBe(404);
  });

  it("refuses a command speaking a protocol version it does not accept", async () => {
    const app = makeApp();
    const open = { whiteboardRoomId: "meet-a", whiteboardId: "wb_a", commandId: "cmd-open-protocol" };

    const future = await fetchRequired(app, await signedCommand("/commands/open", open, TEST_COMMAND_KEYRING, {
      [SYNC_PROTOCOL_HEADER]: String(SYNC_PROTOCOL.accepts.newest + 1),
    }));
    expect(future.status).toBe(426);
    expect(await future.json()).toMatchObject({ ok: false, reason: "incompatible" });

    // A Worker from before the header speaks the first version.
    const unversioned = await fetchRequired(app, await signedCommand("/commands/open", open));
    expect(unversioned.status).toBe(200);
  });

  it("opens a board end to end and captures it", async () => {
    const objects = createMemoryObjectStore();
    const app = makeApp(fakeAuthority(), objects);
    const opened = await fetchRequired(
      app,
      await signedCommand("/commands/open", {
        whiteboardRoomId: "meet-app-open",
        whiteboardId: "wb_app",
        commandId: "cmd-app-open-1",
      }),
    );
    expect(opened.status).toBe(200);
    expect(await opened.json()).toMatchObject({ ok: true, status: "initialized" });

    const revision = whiteboardRevisionKey("wb_app", "rev_1");
    const captured = await fetchRequired(
      app,
      await signedCommand("/commands/capture", {
        whiteboardRoomId: "meet-app-open",
        whiteboardId: "wb_app",
        commandId: "cmd-app-capture-1",
        toKey: revision,
      }),
    );
    expect(await captured.json()).toMatchObject({ ok: true, copy: { key: revision } });

    const read = await fetchRequired(app, await signedCommand("/commands/readSnapshot", { key: revision }));
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ ok: true, meta: { key: revision } });
  });
});

describe("WhiteboardSyncApp sync sockets", () => {
  const ROOM = "meet-app-test" as WhiteboardRoomId;

  it("joins an admitted socket to its room, syncs it, and releases it on close", async () => {
    const app = makeApp();
    const { ws, outcome, closed } = await connect(app, await mintToken({ documentId: "wb_app" }));
    expect(outcome).toBe("open");
    expect(ws.protocol).toBe("orbmeet-wb");
    const room = app.roomManager.getRoomIfExists(ROOM);
    expect(room?.connections.live()).toHaveLength(1);

    // The tldraw handshake, as text frames both ways: the room answers the
    // connect request, then tells the client its access.
    const received: Array<{ type: string }> = [];
    ws.on("message", (data, isBinary) => {
      expect(isBinary).toBe(false);
      const message = JSON.parse(String(data)) as { type: string } | Array<{ type: string }>;
      received.push(...(Array.isArray(message) ? message : [message]));
    });
    ws.send(JSON.stringify({
      type: "connect",
      protocolVersion: getTlsyncProtocolVersion(),
      schema: whiteboardTLSchema.serialize(),
      connectRequestId: "e2e",
      lastServerClock: -1,
    }));
    await vi.waitFor(() => {
      expect(received.map((message) => message.type)).toEqual(expect.arrayContaining(["connect", "custom"]));
    });

    ws.close(1000);
    await closed;
    await vi.waitFor(() => expect(room?.connections.live()).toHaveLength(0));
  });

  it("closes a denied socket with the reason its client acts on, and opens no room", async () => {
    const app = makeApp(fakeAuthority("denied"));
    const { closed } = await connect(app, await mintToken({ documentId: "wb_app" }));
    expect(await closed).toEqual({ code: TLSyncErrorCloseEventCode, reason: TLSyncErrorCloseEventReason.FORBIDDEN });
    expect(app.roomManager.getRoomIfExists(ROOM)).toBeNull();
  });

  it("asks a client with a stale token to authenticate again", async () => {
    const app = makeApp(fakeAuthority("refresh"));
    const { closed } = await connect(app, await mintToken({ documentId: "wb_app" }));
    expect(await closed).toEqual({
      code: TLSyncErrorCloseEventCode,
      reason: TLSyncErrorCloseEventReason.NOT_AUTHENTICATED,
    });
  });

  it("answers a rate-limited upgrade over plain HTTP", async () => {
    const app = makeApp(fakeAuthority(), createMemoryObjectStore(), { ipRateLimit: 1 });
    const first = await connect(app, await mintToken({ documentId: "wb_app" }));
    expect(first.outcome).toBe("open");

    const ws = new WebSocket(`ws://${await originOf(app)}/connect`, [await mintToken({ documentId: "wb_app" }), "orbmeet-wb"], {
      origin: "https://meet.example",
    });
    const [, response] = await once(ws, "unexpected-response");
    expect(response.statusCode).toBe(429);
    expect(response.headers["retry-after"]).toBe("1");
    first.ws.close();
  });

  it("closes a socket that sends a frame above the frame ceiling", async () => {
    const app = makeApp();
    const { ws, closed } = await connect(app, await mintToken({ documentId: "wb_app" }));
    ws.send(Buffer.alloc(WHITEBOARD_CONFIG.MAX_CLIENT_FRAME_BYTES + 1));
    expect((await closed).code).toBe(1009);
  });

  it("asks connected clients to reconnect when it shuts down", async () => {
    const app = makeApp();
    const { outcome, closed } = await connect(app, await mintToken({ documentId: "wb_app" }));
    expect(outcome).toBe("open");
    await app.shutdown("test");
    expect(await closed).toEqual({ code: 1012, reason: "server restarting" });
  });
});

async function mintToken(claims: { documentId?: string } = {}): Promise<string> {
  return createWhiteboardJWT(TEST_JWT_KEYRING, {
    ...claims,
    sub: "user-1",
    name: "User One",
    role: "participant",
    capabilities: {
      canEditWhiteboard: true,
      canControlSurface: false,
      canManageWhiteboard: false,
    },
    sid: "meet-app-test",
    connectionId: "conn-1",
    grantPrincipal: { type: "guest_admission", id: "guest-1" },
  });
}
