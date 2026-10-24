import { afterEach, describe, expect, it, vi } from "vitest";
import { toWhiteboardRoomId } from "@orbmeet/whiteboard-core/whiteboard-room-id";
import {
  installFakeSyncServer,
  TEST_WHITEBOARD_ENV,
} from "@/test/fake-sync-server";

// Where each board lives is D1's (board-placement.d1.test.ts); here every
// board is on the test node, at generation 4, and a board with no row is null.
const placement = vi.hoisted(() => ({
  // TEST_WHITEBOARD_ENV's node, with the keys installFakeSyncServer verifies.
  node: {
    id: "test-node",
    weight: 1,
    whiteboardUrl: "https://whiteboard.test",
    jwtKeyring: new Map([["jwt1", "j".repeat(40)]]),
    commandKeyring: new Map([["cmd1", "c".repeat(40)]]),
  },
  missing: new Set<string>(),
}));
vi.mock("@/modules/whiteboards/server/board-placement.server", () => ({
  placeBoard: vi.fn(async (_db: unknown, _env: unknown, syncRoomId: string) =>
    placement.missing.has(syncRoomId) ? null : { node: placement.node, generation: 4 }),
  nodeForNewBoard: vi.fn(async () => placement.node),
  liveWhiteboardNodes: vi.fn(async () => [placement.node]),
}));

// The cookie helper transitively imports the web app's auth helpers (which reach
// `@/modules/identity/server/crypto` — not resolvable in the whiteboard test env). It is also
// a no-op outside a response context, so stubbing it loses nothing here.
vi.mock("@/modules/whiteboards/server/cookies", () => ({
  setWhiteboardAssetCookies: vi.fn(),
  clearWhiteboardAssetCookie: vi.fn(),
}));


afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildWhiteboardJoinAccessExtras", () => {
  it("mints a token when the service is configured", async () => {
    const { buildWhiteboardJoinAccessExtras } = await import("@/modules/whiteboards/server/orchestration.server");

    const result = await buildWhiteboardJoinAccessExtras(
      {
        ...TEST_WHITEBOARD_ENV,
        APP_URL: "https://app.example.com",
        ENVIRONMENT: "test",
      } as unknown as Env,
      {
        meetingId: "mtg_1",
        participantIdentity: "usr_1",
        participantName: "Atiq",
        participantRole: "participant",
        participantCapabilities: { canEditWhiteboard: true, canControlSurface: true, canManageWhiteboard: true },
        grantPrincipal: { type: "user", id: "usr_1" },
        connectionId: "conn_1",
        mediaNodeId: "test-node",
        whiteboardDocument: {
          whiteboardId: "whiteboard_1",
          syncRoomId: "whiteboard_1",
          title: "Planning",
          surfaceOpen: true,
        },
      },
    );

    expect(result.surface?.availability).toBe("available");
    expect(result.surface?.disabledReason).toBeNull();
    expect(result.surface?.surfaceOpen).toBe(true);
    expect(typeof result.surface?.token).toBe("string");
    expect((result.surface?.token ?? "").length).toBeGreaterThan(0);
    expect(result.surface?.url).toBe("https://whiteboard.test");
    const claims = JSON.parse(atob((result.surface?.token ?? "").split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    expect(claims.generation).toBe(4);
  });

  it("exposes a selected closed document without minting a credential", async () => {
    const { buildWhiteboardJoinAccessExtras } = await import("@/modules/whiteboards/server/orchestration.server");

    const result = await buildWhiteboardJoinAccessExtras(
      {
        ...TEST_WHITEBOARD_ENV,
        APP_URL: "https://app.example.com",
        ENVIRONMENT: "test",
      } as unknown as Env,
      {
        meetingId: "mtg_1",
        participantIdentity: "usr_1",
        participantName: "Atiq",
        participantRole: "participant",
        participantCapabilities: { canEditWhiteboard: true, canControlSurface: true, canManageWhiteboard: true },
        grantPrincipal: { type: "user", id: "usr_1" },
        connectionId: "conn_1",
        mediaNodeId: "test-node",
        whiteboardDocument: {
          whiteboardId: "whiteboard_1",
          syncRoomId: "whiteboard_1",
          title: "Planning",
          surfaceOpen: false,
        },
      },
    );

    expect(result.surface).toMatchObject({
      availability: "available",
      surfaceOpen: false,
      token: null,
      documentId: "whiteboard_1",
      documentTitle: "Planning",
    });
  });

  it("keeps a lazy unprovisioned surface available without creating a document", async () => {
    const { buildWhiteboardJoinAccessExtras } = await import("@/modules/whiteboards/server/orchestration.server");

    const result = await buildWhiteboardJoinAccessExtras(
      {
        ...TEST_WHITEBOARD_ENV,
        APP_URL: "https://app.example.com",
        ENVIRONMENT: "test",
      } as unknown as Env,
      {
        meetingId: "mtg_1",
        participantIdentity: "usr_1",
        participantName: "Atiq",
        participantRole: "participant",
        participantCapabilities: { canEditWhiteboard: true, canControlSurface: true, canManageWhiteboard: true },
        grantPrincipal: { type: "user", id: "usr_1" },
        connectionId: "conn_1",
        mediaNodeId: "test-node",
      },
    );

    expect(result.surface).toEqual({
      availability: "available",
      disabledReason: null,
      surfaceOpen: false,
      token: null,
      url: null,
      documentId: null,
      documentTitle: null,
    });
  });

  it("returns disabled when the URL is not configured", async () => {
    const { buildWhiteboardJoinAccessExtras } = await import("@/modules/whiteboards/server/orchestration.server");

    const result = await buildWhiteboardJoinAccessExtras(
      {
        NODES: "",
        APP_URL: "",
        ENVIRONMENT: "test",
      } as unknown as Env,
      {
        meetingId: "mtg_1",
        participantIdentity: "usr_1",
        participantName: "Atiq",
        participantRole: "participant",
        participantCapabilities: { canEditWhiteboard: true, canControlSurface: true, canManageWhiteboard: true },
        grantPrincipal: { type: "user", id: "usr_1" },
        connectionId: "conn_1",
        mediaNodeId: "test-node",
      },
    );

    expect(result.surface?.availability).toBe("unavailable");
    expect(result.surface?.disabledReason).toBeNull();
    expect(result.surface?.token).toBeNull();
  });

});

describe("sync command channel", () => {
  const env = {
    ...TEST_WHITEBOARD_ENV,
  } as unknown as Env;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends each command to the board's node, at its generation, signed, and returns its typed result", async () => {
    const { runSyncCommand } = await import("@/modules/whiteboards/server/sync-commands.server");
    const { commands } = installFakeSyncServer({
      reopen: () => ({ ok: true, status: "reopened" }),
    });

    const request = {
      whiteboardRoomId: toWhiteboardRoomId("room_1"),
      whiteboardId: "wb_1",
      commandId: "cmd_1",
    };
    await expect(runSyncCommand(env, "reopen", request)).resolves.toEqual({
      ok: true,
      status: "reopened",
    });
    expect(commands).toEqual([{ name: "reopen", request: { ...request, generation: 4 } }]);
  });

  it("sends a command for a board not created yet to a node, with no generation", async () => {
    const { runSyncCommand } = await import("@/modules/whiteboards/server/sync-commands.server");
    const { commands } = installFakeSyncServer({ seed: () => ({ ok: true, assetKeys: [] }) });
    placement.missing.add("wb_new");

    const request = {
      whiteboardRoomId: toWhiteboardRoomId("wb_new"),
      whiteboardId: "wb_new",
      commandId: "cmd_seed",
      source: { key: "whiteboards/wb_1/revisions/r1.json" },
    };
    await runSyncCommand(env, "seed", request);

    expect(commands).toEqual([{ name: "seed", request }]);
  });

  it("maps a typed failure to the matching application error", async () => {
    const { runSyncCommand } = await import("@/modules/whiteboards/server/sync-commands.server");
    installFakeSyncServer({
      pageAdd: () => ({
        ok: false,
        reason: "conflict",
        message: "Maximum page limit (100) reached or room is not ready",
      }),
    });

    await expect(
      runSyncCommand(env, "pageAdd", {
        whiteboardRoomId: toWhiteboardRoomId("room_1"),
        userId: "usr_1",
        connectionId: "conn_1",
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: "CONFLICT" });
  });

  it("treats a rejected signature or an untyped answer as an outage", async () => {
    const { sendSyncCommand } = await import("@/modules/whiteboards/server/sync-commands.server");
    const request = { whiteboardRoomId: toWhiteboardRoomId("room_1") };

    vi.stubGlobal("fetch", vi.fn(async () => new Response("Unauthorized", { status: 401 })));
    await expect(sendSyncCommand(env, "refreshAuthority", request)).resolves.toMatchObject({
      ok: false,
      reason: "unavailable",
    });

    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>", { status: 502 })));
    await expect(sendSyncCommand(env, "refreshAuthority", request)).resolves.toMatchObject({
      ok: false,
      reason: "unavailable",
    });
  });

  it("reads a missing stored snapshot as null", async () => {
    const { readStoredSnapshot } = await import("@/modules/whiteboards/server/sync-commands.server");
    installFakeSyncServer();

    await expect(readStoredSnapshot(env, "whiteboards/wb_1/revisions/r1.json")).resolves.toBeNull();
  });
});
