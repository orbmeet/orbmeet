import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as syncCore from "@tldraw/sync-core";
import { TLSocketRoom } from "@tldraw/sync-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WHITEBOARD_CONFIG } from "@orbmeet/whiteboard-core/config";
import { WHITEBOARD_EVENTS } from "@orbmeet/whiteboard-core/protocol";
import { whiteboardTLSchema } from "@orbmeet/whiteboard-core/room-schema";
import type { WhiteboardRoomId } from "@orbmeet/whiteboard-core/whiteboard-room-id";
import { RoomConnections } from "./room-connections.ts";
import { RoomPresenceLane, type PresenceOp } from "./room-presence-lane.ts";
import { createTestRoom } from "./room-test-support.ts";

const SESSION = "session-1";
const USER = "user-1";

function createLane(budget: { allow: boolean } = { allow: true }) {
  const resyncs: string[] = [];
  const charged: number[] = [];
  const evicted: Array<{ sessionId: string; bytes: number }> = [];
  const lane = new RoomPresenceLane({
    reserveFanout: (_userId, bytes) => {
      if (!budget.allow) return false;
      charged.push(bytes);
      return true;
    },
    requestResync: (sessionId) => resyncs.push(sessionId),
    evictOversized: (sessionId, _userId, bytes) => evicted.push({ sessionId, bytes }),
  });
  return { lane, resyncs, charged, budget, evicted };
}

const record = { typeName: "instance_presence", cursor: { x: 0, y: 0 }, selectedShapeIds: [], scribbles: [], brush: null };
const move = (x: number): PresenceOp => ["patch", { cursor: ["put", { x, y: 0 }] }];

describe("RoomPresenceLane", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  // A record over the message ceiling is never forwarded, so the room's own
  // retained-presence ceiling never sees it: the lane's copy must be bounded
  // where it is kept, or a viewer's patches grow it without end.
  it("evicts a session whose presence outgrows the retained ceiling, and forgets its record", () => {
    const { lane, evicted, charged } = createLane();
    const chunk = "x".repeat(8 * 1024);
    lane.forward(SESSION, USER, ["put", record]);

    let forwarded: PresenceOp | null = ["put", record];
    let patches = 0;
    while (evicted.length === 0 && patches < 10) {
      forwarded = lane.forward(SESSION, USER, ["patch", { [`k${patches}`]: ["put", chunk] }]);
      patches += 1;
    }

    expect(forwarded).toBeNull();
    expect(evicted).toEqual([{ sessionId: SESSION, bytes: expect.any(Number) }]);
    expect(evicted[0].bytes).toBeGreaterThan(WHITEBOARD_CONFIG.MAX_RETAINED_PRESENCE_BYTES);
    expect(patches).toBeLessThanOrEqual(5);
    // Starting again, the session's next patch has nothing to land on.
    charged.length = 0;
    expect(lane.forward(SESSION, USER, move(1))).toEqual(move(1));
  });

  it("forwards each operation as it came while peers are in step", () => {
    const { lane } = createLane();

    expect(lane.forward(SESSION, USER, ["put", record])).toEqual(["put", record]);
    expect(lane.forward(SESSION, USER, move(1))).toEqual(move(1));
  });

  // tldraw's client diffs against what it last pushed, not what the room
  // applied: once one update is dropped, later diffs land on a record the
  // client does not have. The next update must carry the whole record.
  it("forwards the whole record after dropping an update, including what the drop held", () => {
    const { lane, budget } = createLane();
    lane.forward(SESSION, USER, ["put", record]);

    budget.allow = false;
    expect(lane.forward(SESSION, USER, ["patch", { selectedShapeIds: ["put", ["shape:a"]] }])).toBeNull();
    budget.allow = true;

    expect(lane.forward(SESSION, USER, move(5))).toEqual([
      "put",
      { ...record, selectedShapeIds: ["shape:a"], cursor: { x: 5, y: 0 } },
    ]);
    // Back in step: the next is an ordinary patch again.
    expect(lane.forward(SESSION, USER, move(6))).toEqual(move(6));
  });

  // A session that has stopped moving sends no next update, so a dropped
  // "gone quiet" would leave its cursor frozen on every peer.
  it("asks a session to resync when nothing follows a dropped update", () => {
    const { lane, budget, resyncs } = createLane();
    lane.forward(SESSION, USER, ["put", record]);
    budget.allow = false;
    lane.forward(SESSION, USER, ["patch", { cursor: ["put", null] }]);
    budget.allow = true;

    vi.advanceTimersByTime(1_000);
    expect(resyncs).toEqual([SESSION]);

    // The resync is a presence change like any other, and goes out whole.
    expect(lane.forward(SESSION, USER, ["patch", { meta: ["put", { orbmeetPresenceResync: 1 }] }])).toEqual([
      "put",
      { ...record, cursor: null, meta: { orbmeetPresenceResync: 1 } },
    ]);
  });

  it("asks nothing once the session is back in step on its own", () => {
    const { lane, budget, resyncs } = createLane();
    lane.forward(SESSION, USER, ["put", record]);
    budget.allow = false;
    lane.forward(SESSION, USER, move(1));
    budget.allow = true;
    lane.forward(SESSION, USER, move(2));

    vi.advanceTimersByTime(1_000);
    expect(resyncs).toEqual([]);
  });

  it("sends an oversized record without its unbounded fields, and the whole record again next time", () => {
    const { lane } = createLane();
    const selection = Array.from({ length: 2_000 }, (_, index) => `shape:${index}`);
    expect(JSON.stringify(selection).length).toBeGreaterThan(WHITEBOARD_CONFIG.MAX_PRESENCE_MESSAGE_BYTES);

    expect(lane.forward(SESSION, USER, ["put", { ...record, selectedShapeIds: selection }])).toEqual([
      "put",
      { ...record, selectedShapeIds: [] },
    ]);
    // Still out of step: the selection never reached peers.
    expect(lane.forward(SESSION, USER, ["patch", { selectedShapeIds: ["put", ["shape:a"]] }])).toEqual([
      "put",
      { ...record, selectedShapeIds: ["shape:a"] },
    ]);
  });

  it("charges what it forwards, not what was sent", () => {
    const { lane, budget, charged } = createLane();
    lane.forward(SESSION, USER, ["put", record]);
    budget.allow = false;
    lane.forward(SESSION, USER, move(1));
    budget.allow = true;
    charged.length = 0;

    const forwarded = lane.forward(SESSION, USER, move(2));
    expect(charged).toEqual([Buffer.byteLength(JSON.stringify(forwarded), "utf8")]);
  });

  it("forgets a session that leaves, and asks it nothing afterwards", () => {
    const { lane, budget, resyncs } = createLane();
    lane.forward(SESSION, USER, ["put", record]);
    budget.allow = false;
    lane.forward(SESSION, USER, move(1));

    lane.deleteSession(SESSION);
    vi.advanceTimersByTime(1_000);
    expect(resyncs).toEqual([]);
  });
});

describe("RoomPresenceLane, in a room", () => {
  const dirs: string[] = [];
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("asks a session whose presence the room had to drop to send it again", () => {
    vi.useFakeTimers();
    const { getTlsyncProtocolVersion } = syncCore as unknown as { getTlsyncProtocolVersion(): number };
    const dir = mkdtempSync(join(tmpdir(), "orbmeet-presence-lane-"));
    dirs.push(dir);
    const roomId = "meet-presence-resync" as WhiteboardRoomId;
    const room = createTestRoom(roomId, dir);
    const sent: Array<{ sessionId: string; data: { type?: unknown } }> = [];
    vi.spyOn(TLSocketRoom.prototype, "sendCustomMessage").mockImplementation(((sessionId: string, data: unknown) => {
      sent.push({ sessionId, data: data as { type?: unknown } });
    }) as never);
    const sessionId = "viewer:sess";
    room.handleConnect({ readyState: 1, send: () => {}, close: () => {} }, {
      tldrawSessionId: sessionId,
      userId: "viewer",
      userName: "Viewer",
      role: "participant",
      capabilities: { canEditWhiteboard: false, canControlSurface: false, canManageWhiteboard: false },
      grantPrincipal: { type: "user", id: "viewer" },
      whiteboardRoomId: roomId,
      connectionId: "conn-viewer",
    });
    room.handleMessage(sessionId, JSON.stringify({
      type: "connect",
      protocolVersion: getTlsyncProtocolVersion(),
      schema: whiteboardTLSchema.serialize(),
      connectRequestId: "c",
      lastServerClock: -1,
    }));

    vi.spyOn(RoomConnections.prototype, "reservePresenceFanout").mockReturnValue(false);
    room.handleMessage(sessionId, JSON.stringify({
      type: "push",
      clientClock: 1,
      presence: ["patch", { cursor: ["put", null] }],
    }));
    vi.advanceTimersByTime(1_000);

    expect(sent).toContainEqual({ sessionId, data: { type: WHITEBOARD_EVENTS.PRESENCE_RESYNC } });
    room.close();
  });
});
