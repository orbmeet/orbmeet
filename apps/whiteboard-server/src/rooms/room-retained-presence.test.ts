import { whiteboardTLSchema } from "@orbmeet/whiteboard-core/room-schema";
import { InstancePresenceRecordType, createUserId } from "@tldraw/tlschema";
import { TLSocketRoom, NodeSqliteWrapper, SQLiteSyncStorage } from "@tldraw/sync-core";
import * as syncCore from "@tldraw/sync-core";
// Runtime protocol helper is marked internal and omitted from published types.
const { getTlsyncProtocolVersion } = syncCore as unknown as { getTlsyncProtocolVersion(): number };
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TldrawSocket, SocketSession } from "./room-types.ts";
import type { Room as RoomInstance } from "./room.ts";
import type { WhiteboardRoomId } from "@orbmeet/whiteboard-core/whiteboard-room-id";
import { createEmptyWhiteboardRoomSnapshot } from "@orbmeet/whiteboard-core/room-snapshot-validation";

// Shrink ONLY the room-total presence budget for this file: the per-session
// mechanics are exercised at production sizes, but a production-sized total
// budget needs ~70 live sessions to breach, which drags quadratic connect-reply
// fanout into the test for no extra coverage. The room modules read the budget
// when they load, and each test file has its own module registry.
vi.mock("@orbmeet/whiteboard-core/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@orbmeet/whiteboard-core/config")>();
  return {
    ...actual,
    WHITEBOARD_CONFIG: {
      ...actual.WHITEBOARD_CONFIG,
      MAX_TOTAL_RETAINED_PRESENCE_BYTES: 100 * 1024,
    },
  };
});
const { WHITEBOARD_CONFIG } = await import("@orbmeet/whiteboard-core/config");
const { createTestRoom } = await import("./room-test-support.ts");

const MAX_RETAINED_PRESENCE_BYTES = WHITEBOARD_CONFIG.MAX_RETAINED_PRESENCE_BYTES;
const MAX_TOTAL_RETAINED_PRESENCE_BYTES = WHITEBOARD_CONFIG.MAX_TOTAL_RETAINED_PRESENCE_BYTES;

const tempDirs: string[] = [];
function makeDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "orbmeet-room-retained-presence-"));
  tempDirs.push(dir);
  return dir;
}

function makeSocket(): TldrawSocket & { sent: string[]; closed: Array<[number?, string?]> } {
  const sent: string[] = [];
  const closed: Array<[number?, string?]> = [];
  return {
    sent,
    closed,
    readyState: 1,
    send: (data: string | Uint8Array) => {
      sent.push(typeof data === "string" ? data : "binary");
    },
    close: (code?: number, reason?: string) => {
      closed.push([code, reason]);
    },
  };
}

function makeWsData(
  whiteboardRoomId: WhiteboardRoomId,
  sessionId: string,
  userId: string,
  canEdit = true,
): SocketSession {
  return {
    tldrawSessionId: sessionId,
    userId,
    userName: `User ${userId}`,
    role: "participant",
    capabilities: {
      canEditWhiteboard: canEdit,
      canControlSurface: canEdit,
      canManageWhiteboard: canEdit,
    },
    grantPrincipal: { type: "user", id: userId },
    whiteboardRoomId,
    connectionId: `conn-${userId}`,
  };
}

function connectSession(room: RoomInstance, socket: ReturnType<typeof makeSocket>, data: SocketSession): void {
  room.handleConnect(socket, data);
  // Complete the tldraw connect handshake.
  room.handleMessage(
    data.tldrawSessionId,
    JSON.stringify({
      type: "connect",
      protocolVersion: getTlsyncProtocolVersion(),
      schema: whiteboardTLSchema.serialize(),
      connectRequestId: "confirm",
      lastServerClock: -1,
    }),
  );
}

/** A schema-valid seed record; the room overrides its identity fields. */
function seedPresence(userId: string): Record<string, unknown> {
  return InstancePresenceRecordType.create({
    userId: createUserId(`user:${userId}`),
    userName: `User ${userId}`,
    currentPageId: "page:page" as never,
  }) as unknown as Record<string, unknown>;
}

/**
 * The retained bytes of each presence record, read the same way the room's
 * enforcement reads them: through sync-core's own presence store.
 */
function retainedPresenceSizes(room: RoomInstance): number[] {
  const records = (
    room.connections as unknown as {
      retainedPresence: { presenceRecordsOf(): Record<string, Record<string, unknown>> };
    }
  ).retainedPresence.presenceRecordsOf();
  return Object.values(records).map((record) =>
    Buffer.byteLength(JSON.stringify(record), "utf8"),
  );
}

/** One under-cap presence patch whose merge grows the retained record. */
function fatMetaPatch(clientClock: number, paddingBytes = 3000): string {
  return JSON.stringify({
    type: "push",
    clientClock,
    diff: {},
    presence: ["patch", { meta: ["patch", { [`padding-${clientClock}`]: ["put", "x".repeat(paddingBytes)] }] }],
  });
}

/** One under-cap presence put that replaces the record with a padded one. */
function fatPresencePut(userId: string, clientClock: number, paddingBytes = 14_000): string {
  return JSON.stringify({
    type: "push",
    clientClock,
    diff: {},
    presence: ["put", { ...seedPresence(userId), meta: { padding: "x".repeat(paddingBytes) } }],
  });
}

/** Seed presence, then patch until the room evicts the session. */
function growUntilEvicted(
  room: RoomInstance,
  sessionId: string,
  socket: ReturnType<typeof makeSocket>,
): number {
  room.handleMessage(sessionId, JSON.stringify({
    type: "push",
    clientClock: 1,
    diff: {},
    presence: ["put", seedPresence(sessionId.split(":")[0])],
  }));
  for (let i = 0; i < 60; i += 1) {
    room.handleMessage(sessionId, fatMetaPatch(i + 2));
    if (socket.closed.length > 0) return i;
  }
  return -1;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("retained presence ceilings", () => {
  it("evicts a session whose under-cap patches accumulate past the retained ceiling", async () => {
    // The control group first: the same patches against a bare sync-core room
    // (what the wrapper wraps) retain far more than the ceiling, which is the
    // finding — per-message limits bound nothing about the retained record.
    const bare = new TLSocketRoom({
      schema: whiteboardTLSchema,
      storage: new SQLiteSyncStorage({
        sql: new NodeSqliteWrapper(new DatabaseSync(":memory:")),
        snapshot: createEmptyWhiteboardRoomSnapshot(),
      }),
      log: { warn: () => {}, error: () => {} },
    });
    bare.handleSocketConnect({
      sessionId: "sess-1",
      socket: makeSocket() as never,
      meta: { userId: "user:editor-1" } as never,
    } as never);
    bare.handleSocketMessage("sess-1", JSON.stringify({
      type: "connect",
      protocolVersion: getTlsyncProtocolVersion(),
      schema: whiteboardTLSchema.serialize(),
      connectRequestId: "confirm",
      lastServerClock: -1,
    }));
    await vi.advanceTimersByTimeAsync(0);
    bare.handleSocketMessage("sess-1", JSON.stringify({
      type: "push",
      clientClock: 1,
      diff: {},
      presence: ["put", seedPresence("editor-1")],
    }));
    for (let i = 0; i < 40; i += 1) {
      bare.handleSocketMessage("sess-1", fatMetaPatch(i + 2));
    }
    // `getPresenceRecords` is @internal in sync-core and omitted from its
    // published types (the same access the room's enforcement uses).
    const barePresence = (
      bare as unknown as { getPresenceRecords(): Record<string, unknown> }
    ).getPresenceRecords();
    const bareRetained = Object.values(barePresence).map((record) =>
      Buffer.byteLength(JSON.stringify(record), "utf8"),
    );
    expect(bareRetained.length).toBe(1);
    expect(bareRetained[0]).toBeGreaterThan(MAX_RETAINED_PRESENCE_BYTES);
    bare.close();

    // Now the same traffic through the Room wrapper: every message is under
    // the per-message presence cap, yet the retained record is bounded — the
    // breaching session's presence is evicted instead of kept.
    const whiteboardRoomId = "meet-retained-1" as WhiteboardRoomId;
    const room = createTestRoom(whiteboardRoomId, makeDataDir(), vi.fn());
    const socket = makeSocket();
    const sessionId = "editor-1:sess";
    connectSession(room, socket, makeWsData(whiteboardRoomId, sessionId, "editor-1"));
    expect(socket.closed).toHaveLength(0);

    const evictedAt = growUntilEvicted(room, sessionId, socket);
    expect(evictedAt).toBeGreaterThanOrEqual(0);

    // The eviction removed the retained record (the same propagation a session
    // close performs) instead of leaving it until the session dies.
    expect(retainedPresenceSizes(room)).toHaveLength(0);
    room.close();
  });

  it("covers the read-only path: a viewer's presence patches are bounded too", () => {
    // Read-only participants' presence flows through the same guard (their
    // pushes are narrowed to presence) and the same presence store. The
    // ceiling is on retained state, so write permission is irrelevant.
    const whiteboardRoomId = "meet-retained-2" as WhiteboardRoomId;
    const room = createTestRoom(whiteboardRoomId, makeDataDir(), vi.fn());
    const socket = makeSocket();
    const sessionId = "viewer-1:sess";
    connectSession(room, socket, makeWsData(whiteboardRoomId, sessionId, "viewer-1", false));

    room.handleMessage(sessionId, JSON.stringify({
      type: "push",
      clientClock: 1,
      diff: { "shape:not-allowed": ["patch", { x: ["put", 5] }] },
      presence: ["put", seedPresence("viewer-1")],
    }));
    // The viewer's diff was narrowed away; its presence is retained.
    expect(retainedPresenceSizes(room)).toHaveLength(1);

    expect(growUntilEvicted(room, sessionId, socket)).toBeGreaterThanOrEqual(0);
    const sizes = retainedPresenceSizes(room);
    expect(sizes.every((size) => size <= MAX_RETAINED_PRESENCE_BYTES)).toBe(true);
    room.close();
  });

  it("lets a republished session keep a healthy retained record after an eviction", () => {
    const whiteboardRoomId = "meet-retained-3" as WhiteboardRoomId;
    const room = createTestRoom(whiteboardRoomId, makeDataDir(), vi.fn());

    // First session breaches and is evicted.
    const firstSocket = makeSocket();
    const firstSessionId = "editor-1:sess";
    connectSession(room, firstSocket, makeWsData(whiteboardRoomId, firstSessionId, "editor-1"));
    expect(growUntilEvicted(room, firstSessionId, firstSocket)).toBeGreaterThanOrEqual(0);
    expect(retainedPresenceSizes(room)).toHaveLength(0);

    // The recovery semantic is republish-on-reconnect: the replacement session
    // starts from an empty record and stays under the ceiling.
    const secondSocket = makeSocket();
    const secondSessionId = "editor-1:sess-2";
    connectSession(room, secondSocket, makeWsData(whiteboardRoomId, secondSessionId, "editor-1"));
    expect(secondSocket.closed).toHaveLength(0);
    room.handleMessage(secondSessionId, JSON.stringify({
      type: "push",
      clientClock: 1,
      diff: {},
      presence: ["put", seedPresence("editor-1")],
    }));
    for (let i = 0; i < 5; i += 1) {
      room.handleMessage(secondSessionId, fatMetaPatch(i + 2, 500));
    }
    expect(secondSocket.closed).toHaveLength(0);
    const sizes = retainedPresenceSizes(room);
    expect(sizes).toHaveLength(1);
    expect(sizes[0]).toBeLessThanOrEqual(MAX_RETAINED_PRESENCE_BYTES);
    room.close();
  });

  it("evicts the largest retained record when the room total breaches its budget", () => {
    const whiteboardRoomId = "meet-retained-4" as WhiteboardRoomId;
    const room = createTestRoom(whiteboardRoomId, makeDataDir(), vi.fn());
    const sessions = fillPastRoomBudget(room, whiteboardRoomId, (userId) => [
      JSON.stringify({ type: "push", clientClock: 1, diff: {}, presence: ["put", seedPresence(userId)] }),
      ...[2, 3, 4].map((clientClock) => fatMetaPatch(clientClock, 10_000)),
    ]);

    // The room-total sweep is amortized to one per second, and each sweep
    // evicts only the largest holder: the room converges under the budget a
    // few windows at a time instead of serializing the whole store per message.
    const evictedCount = sweepRoomBudget(room, sessions, (_userId, sweep) =>
      fatMetaPatch(100 + sweep, 10));
    expect(evictedCount).toBeGreaterThanOrEqual(1);
    expectRoomUnderBudget(room, sessions);
    room.close();
  });

  it("enforces the room budget when sessions publish only presence puts", () => {
    // A `put` replaces one session's record, which says nothing about the
    // room total: the sweep must run for it exactly as it does for a patch.
    const whiteboardRoomId = "meet-retained-5" as WhiteboardRoomId;
    const room = createTestRoom(whiteboardRoomId, makeDataDir(), vi.fn());
    const sessions = fillPastRoomBudget(room, whiteboardRoomId, (userId) => [
      fatPresencePut(userId, 1),
    ]);

    const evictedCount = sweepRoomBudget(room, sessions, (userId, sweep) =>
      fatPresencePut(userId, 100 + sweep));
    expect(evictedCount).toBeGreaterThanOrEqual(1);
    expectRoomUnderBudget(room, sessions);
    room.close();
  });
});

interface FilledSession {
  socket: ReturnType<typeof makeSocket>;
  userId: string;
  sessionId: string;
}

/**
 * Connect sessions, each publishing `messagesFor(userId)` (every message under
 * the per-message presence cap), until the room total is over budget while no
 * single session is over its own ceiling.
 */
function fillPastRoomBudget(
  room: RoomInstance,
  whiteboardRoomId: WhiteboardRoomId,
  messagesFor: (userId: string) => string[],
): FilledSession[] {
  const sessions: FilledSession[] = [];
  while (totalRetained(room) <= MAX_TOTAL_RETAINED_PRESENCE_BYTES && sessions.length < 20) {
    const userId = `editor-${sessions.length}`;
    const sessionId = `${userId}:sess`;
    const socket = makeSocket();
    connectSession(room, socket, makeWsData(whiteboardRoomId, sessionId, userId));
    for (const message of messagesFor(userId)) room.handleMessage(sessionId, message);
    if (socket.closed.length > 0) throw new Error(`${sessionId} was evicted during fill`);
    sessions.push({ socket, userId, sessionId });
  }
  const sizes = retainedPresenceSizes(room);
  expect(sizes).toHaveLength(sessions.length);
  expect(sizes.every((size) => size <= MAX_RETAINED_PRESENCE_BYTES)).toBe(true);
  expect(totalRetained(room)).toBeGreaterThan(MAX_TOTAL_RETAINED_PRESENCE_BYTES);
  return sessions;
}

/**
 * Send one presence message per sweep window from a still-live session and
 * count the windows that evicted someone.
 */
function sweepRoomBudget(
  room: RoomInstance,
  sessions: FilledSession[],
  message: (userId: string, sweep: number) => string,
): number {
  let evictedCount = 0;
  for (let sweep = 0; sweep < 5; sweep += 1) {
    if (totalRetained(room) <= MAX_TOTAL_RETAINED_PRESENCE_BYTES) break;
    vi.advanceTimersByTime(1001);
    const live = sessions.find(({ socket }) => socket.closed.length === 0);
    if (!live) break;
    const before = retainedPresenceSizes(room).length;
    room.handleMessage(live.sessionId, message(live.userId, sweep));
    if (retainedPresenceSizes(room).length < before) evictedCount += 1;
  }
  return evictedCount;
}

function expectRoomUnderBudget(room: RoomInstance, sessions: FilledSession[]): void {
  expect(totalRetained(room)).toBeLessThanOrEqual(MAX_TOTAL_RETAINED_PRESENCE_BYTES);
  expect(retainedPresenceSizes(room).length).toBeLessThan(sessions.length);
}

function totalRetained(room: RoomInstance): number {
  return retainedPresenceSizes(room).reduce((sum, size) => sum + size, 0);
}
