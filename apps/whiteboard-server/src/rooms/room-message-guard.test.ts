import { afterEach, describe, expect, it, vi } from "vitest";
import { TLSyncErrorCloseEventReason } from "@tldraw/sync-core";
import { RoomMessageGuard } from "./room-message-guard.ts";
import { WHITEBOARD_CONFIG } from "@orbmeet/whiteboard-core/config";
import type { SessionMeta } from "./room-types.ts";
import { toWhiteboardRoomId } from "@orbmeet/whiteboard-core/whiteboard-room-id";

const { MAX_ROOM_WRITE_BYTES } = WHITEBOARD_CONFIG;

// Mirror the internal tuning constants in room-message-guard.ts.
const REMEASURE_MIN_INTERVAL_MS = 2_000;
const MEASURE_AFTER_ACCEPTED_BYTES = 512 * 1024;
const REMOVING_WRITE_HEADROOM_BYTES = 4 * 1024 * 1024;

const SESSION_ID = "user-1:abcd1234";

function editorMeta(): SessionMeta {
  return {
    userId: "user-1",
    userName: "Alice",
    role: "participant",
    capabilities: { canEditWhiteboard: true, canControlSurface: false, canManageWhiteboard: false },
    grantPrincipal: { type: "user", id: "user-1" },
    grantPrincipalKey: "user:user-1",
    writesSuspended: false,
    whiteboardRoomId: toWhiteboardRoomId("room"),
    connectionId: "conn-1",
    connectedReadonly: false,
  };
}

function snapshotOfBytes(byteLength: number): unknown {
  return {
    documentClock: 1,
    documents: [
      {
        state: {
          typeName: "shape",
          type: "geo",
          id: "shape:pad",
          pad: "x".repeat(byteLength),
        },
      },
    ],
  };
}

function removeMessage(id = "shape:gone"): string {
  return JSON.stringify({ type: "push", clientClock: 1, diff: { [id]: ["remove"] } });
}

function putMessage(id = "shape:new", padBytes = 0): string {
  return JSON.stringify({
    type: "push",
    clientClock: 1,
    diff: {
      [id]: [
        "put",
        { typeName: "shape", type: "geo", id, pad: "x".repeat(padBytes) },
      ],
    },
  });
}

function createGuard(
  initialSnapshot: unknown,
  canEditWhiteboard = true,
  sessionMeta: SessionMeta | null = editorMeta(),
  canAcceptDocumentMutations = true,
  maxRoomAssemblyBytes?: number,
) {
  let snapshot = initialSnapshot;
  const getSnapshot = vi.fn(() => snapshot);
  const sentMessages: unknown[] = [];
  const roomSizeRecovered = vi.fn();
  const closedSessions: string[] = [];
  const closeReasons: Array<string | undefined> = [];
  const discardedPushes: Array<{ sessionId: string; clientClock: number }> = [];
  const guard = new RoomMessageGuard({
    whiteboardRoomId: toWhiteboardRoomId("room"),
    getSnapshot,
    getSessionMeta: () => sessionMeta ?? undefined,
    canEditWhiteboardForMeta: () => canEditWhiteboard,
    canAcceptDocumentMutations: () => canAcceptDocumentMutations,
    sendCustomMessage: (_sessionId, data) => {
      sentMessages.push(data);
    },
    discardPush: (sessionId, clientClock) => {
      discardedPushes.push({ sessionId, clientClock });
    },
    onRoomSizeRecovered: roomSizeRecovered,
    closeSession: (sessionId, reason) => {
      closedSessions.push(sessionId);
      closeReasons.push(reason);
    },
    closeSessionTransiently: (sessionId) => {
      closedSessions.push(sessionId);
      closeReasons.push(undefined);
    },
    maxRoomAssemblyBytes,
  });
  guard.addSession(SESSION_ID);
  return {
    guard,
    getSnapshot,
    sentMessages,
    roomSizeRecovered,
    closedSessions,
    closeReasons,
    discardedPushes,
    setSnapshot: (next: unknown) => {
      snapshot = next;
    },
  };
}

function evaluateAndRecord(guard: RoomMessageGuard, message: string): boolean {
  const decision = guard.evaluate(SESSION_ID, message);
  if (decision.accept) guard.recordAcceptedMessage(decision);
  return decision.accept;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("RoomMessageGuard session authority", () => {
  it("fails closed when no authenticated session metadata exists", () => {
    const { guard } = createGuard(snapshotOfBytes(10), true, null);
    expect(guard.evaluate(SESSION_ID, putMessage()).accept).toBe(false);
  });
});

describe("RoomMessageGuard room-size accounting", () => {
  it("refreshes page authority and size after a server snapshot replacement", () => {
    const { guard, setSnapshot, closedSessions, discardedPushes } = createGuard(snapshotOfBytes(10));
    const restored = {
      documents: [{
        state: {
          id: "shape:restored-page",
          typeName: "shape",
          type: "whiteboard-page",
          props: { w: 1200, h: 900, name: "Restored", background: "white" },
        },
      }],
    };
    setSnapshot(restored);
    guard.noteServerSnapshotReplacement();

    expect(guard.getEstimatedRoomBytes()).toBe(
      Buffer.byteLength(JSON.stringify(restored), "utf8"),
    );
    // The restored page is now the board's only one, so removing it is refused.
    const decision = guard.evaluate(SESSION_ID, JSON.stringify({
      type: "push",
      clientClock: 1,
      diff: {
        "shape:restored-page": ["remove"],
      },
    }));
    expect(decision.accept).toBe(false);
    expect(discardedPushes).toHaveLength(1);
    expect(closedSessions).toEqual([]);
  });

  it("does not re-serialize the snapshot on remove-only messages", () => {
    const { guard, getSnapshot } = createGuard(snapshotOfBytes(1024));
    // Constructor measures once for page-frame ids and once for byte size.
    const constructorCalls = getSnapshot.mock.calls.length;

    for (let i = 0; i < 25; i++) {
      expect(evaluateAndRecord(guard, removeMessage(`shape:${i}`))).toBe(true);
    }

    expect(getSnapshot.mock.calls.length).toBe(constructorCalls);
  });

  it("rejects an over-limit projection that already rests on an exact measurement", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const { guard, getSnapshot, closedSessions, sentMessages, discardedPushes } = createGuard(
      snapshotOfBytes(MAX_ROOM_WRITE_BYTES),
    );
    const constructorCalls = getSnapshot.mock.calls.length;

    const decision = guard.evaluate(SESSION_ID, putMessage());
    expect(decision.accept).toBe(false);
    expect(closedSessions).toEqual([]);
    expect(discardedPushes).toEqual([{ sessionId: SESSION_ID, clientClock: 1 }]);
    expect(sentMessages).toEqual([
      expect.objectContaining({ maxBytes: MAX_ROOM_WRITE_BYTES }),
    ]);
    // Nothing has been accepted since the constructor measured, so the estimate
    // is still exact and the rejection costs no further serialization.
    expect(getSnapshot.mock.calls.length).toBe(constructorCalls);

    // And a client parked against a genuinely full room never buys one either:
    // rejected pushes are not recorded, so no drift ever accumulates.
    for (let i = 0; i < 20; i++) {
      expect(guard.evaluate(SESSION_ID, putMessage(`shape:b${i}`)).accept).toBe(false);
    }
    expect(getSnapshot.mock.calls.length).toBe(constructorCalls);
  });

  it("refuses an unauthorized push for what it is, without signalling a full room", () => {
    const { guard, closeReasons, sentMessages, discardedPushes } = createGuard(
      snapshotOfBytes(MAX_ROOM_WRITE_BYTES),
    );
    // A malformed op, at a room the push would also overfill.
    const decision = guard.evaluate(SESSION_ID, JSON.stringify({
      type: "push",
      clientClock: 1,
      diff: { "shape:new": ["replace", { id: "shape:new", typeName: "shape" }] },
    }));

    expect(decision.accept).toBe(false);
    expect(closeReasons).toEqual([TLSyncErrorCloseEventReason.FORBIDDEN]);
    expect(sentMessages).toEqual([]);
    expect(discardedPushes).toEqual([]);
    expect(guard.isRoomSizeLimited()).toBe(false);
  });

  it("announces recovery once the throttle allows after a mutation leaves the room under the cap", () => {
    vi.useFakeTimers();
    const { guard, setSnapshot, roomSizeRecovered } = createGuard(
      snapshotOfBytes(MAX_ROOM_WRITE_BYTES),
    );
    expect(guard.evaluate(SESSION_ID, putMessage()).accept).toBe(false);

    const deletion = guard.evaluate(SESSION_ID, removeMessage());
    expect(deletion.accept).toBe(true);
    // Room.handleMessage applies the accepted diff before recording it.
    setSnapshot(snapshotOfBytes(1024));
    guard.recordAcceptedMessage(deletion);
    // The rejection just measured; the next look waits out the window, and
    // happens even though no further message arrives.
    expect(roomSizeRecovered).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2_000);
    expect(roomSizeRecovered).toHaveBeenCalledTimes(1);

    const next = guard.evaluate(SESSION_ID, putMessage("shape:small"));
    expect(next.accept).toBe(true);
    setSnapshot(snapshotOfBytes(2048));
    guard.recordAcceptedMessage(next);
    expect(roomSizeRecovered).toHaveBeenCalledTimes(1);
  });

  it("serializes at most once per window while deletes stream in at the cap (REVIEW #1)", () => {
    vi.useFakeTimers();
    const { guard, getSnapshot } = createGuard(snapshotOfBytes(MAX_ROOM_WRITE_BYTES));
    expect(guard.evaluate(SESSION_ID, putMessage()).accept).toBe(false);
    const before = getSnapshot.mock.calls.length;

    for (let index = 0; index < 200; index++) {
      const deletion = guard.evaluate(SESSION_ID, removeMessage());
      expect(deletion.accept).toBe(true);
      guard.recordAcceptedMessage(deletion);
    }
    expect(getSnapshot.mock.calls.length - before).toBe(0);

    vi.advanceTimersByTime(2_000);
    expect(getSnapshot.mock.calls.length - before).toBe(1);
  });

  it("never rejects a healthy write on a stale-high estimate", () => {
    // The running total charges every accepted mutation at full wire size, so a
    // burst inflates it far past the real document. Rejecting on that estimate
    // closed editors with ROOM_FULL against a nearly empty room.
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const { guard, closedSessions } = createGuard(snapshotOfBytes(1024));

    // ~24 MB of accepted wire bytes against a 20 MB cap, all inside one
    // re-measure window, while the document itself never grows.
    const padBytes = 2 * 1024 * 1024;
    for (let i = 0; i < 12; i++) {
      expect(evaluateAndRecord(guard, putMessage(`shape:${i}`, padBytes))).toBe(true);
    }
    expect(closedSessions).toEqual([]);
  });

  it("recovers on its own after a failed measurement instead of bricking the room", () => {
    // A transient serialization failure fails closed at MAX_ROOM_WRITE_BYTES.
    // Recovery must not depend on a remove-only push ever arriving: while the
    // estimate is pinned, every editor is being closed with ROOM_FULL.
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const unserializable: Record<string, unknown> = { documents: [] };
    unserializable.self = unserializable;
    const { guard, setSnapshot, closedSessions } = createGuard(unserializable);

    // Arm the throttle window while the snapshot is still unserializable, so the
    // estimate stays pinned at the cap.
    expect(evaluateAndRecord(guard, putMessage("shape:a"))).toBe(false);
    expect(closedSessions).toEqual([]);

    // Serialization recovers and the document is tiny, but we are inside the window.
    setSnapshot(snapshotOfBytes(1024));
    expect(evaluateAndRecord(guard, putMessage("shape:b"))).toBe(false);

    // The next window re-measures and writes flow again, with no remove-only
    // push required to unstick it.
    vi.setSystemTime(1_000_000 + REMEASURE_MIN_INTERVAL_MS + 1);
    expect(evaluateAndRecord(guard, putMessage("shape:c"))).toBe(true);
  });

  it("admits a delete that also patches another record when the room is at the cap", () => {
    // tldraw ships one diff per push, so a delete that rebinds an arrow or
    // dissolves a group arrives as remove + patch. Judging that by its wire size
    // rejected the exact message that would free space, closing the session with
    // ROOM_FULL and leaving the user no way to get back under the limit.
    const { guard, closedSessions } = createGuard(
      snapshotOfBytes(MAX_ROOM_WRITE_BYTES),
    );

    const mixedDelete = JSON.stringify({
      type: "push",
      clientClock: 1,
      diff: {
        "shape:gone": ["remove"],
        "shape:neighbour": ["patch", { parentId: ["put", "shape:frame-1"] }],
      },
    });

    const decision = guard.evaluate(SESSION_ID, mixedDelete);
    expect(decision.sizeEffect).toBe("may-shrink");
    expect(decision.accept).toBe(true);
    expect(closedSessions).toEqual([]);

    // Purely additive writes are still refused while the room is over the cap.
    expect(guard.evaluate(SESSION_ID, putMessage("shape:new")).accept).toBe(false);
  });

  it("still bounds a client that attaches a token remove to every write", () => {
    // The headroom for removing writes is an allowance, not an exemption.
    const { guard } = createGuard(
      snapshotOfBytes(MAX_ROOM_WRITE_BYTES + REMOVING_WRITE_HEADROOM_BYTES),
    );

    const smuggledWrite = JSON.stringify({
      type: "push",
      clientClock: 1,
      diff: {
        "shape:token": ["remove"],
        "shape:payload": [
          "put",
          { typeName: "shape", type: "geo", id: "shape:payload", pad: "x".repeat(4096) },
        ],
      },
    });

    const decision = guard.evaluate(SESSION_ID, smuggledWrite);
    expect(decision.sizeEffect).toBe("may-shrink");
    expect(decision.accept).toBe(false);

    // A push that only removes is never refused -- that is the guaranteed escape.
    expect(guard.evaluate(SESSION_ID, removeMessage()).accept).toBe(true);
  });

  it("re-measures once after removes and accepts growth when the document shrank", () => {
    const { guard, getSnapshot, setSnapshot, closedSessions } = createGuard(
      snapshotOfBytes(MAX_ROOM_WRITE_BYTES),
    );

    // The document shrinks (erase), but the guard's measurement is stale-high.
    setSnapshot(snapshotOfBytes(1024));
    expect(evaluateAndRecord(guard, removeMessage())).toBe(true);
    const callsBeforeGrow = getSnapshot.mock.calls.length;

    expect(evaluateAndRecord(guard, putMessage("shape:after-erase"))).toBe(true);
    expect(closedSessions).toEqual([]);
    // Exactly one lazy re-measure, triggered by the over-limit projection.
    expect(getSnapshot.mock.calls.length).toBe(callsBeforeGrow + 1);
  });

  it("bounds accept-path re-measures to one per throttle window", () => {
    // The accept path amortizes its re-measure over accepted bytes, but that
    // budget is spent by traffic: at the client ingress ceiling, an unthrottled
    // accept path serializes a document up to MAX_ROOM_WRITE_BYTES dozens of
    // times a second, on the loop every room on the host shares.
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const { guard, getSnapshot } = createGuard(snapshotOfBytes(1024));
    // The constructor's measurement stamps the window, so step past it first —
    // an estimate that was just measured exactly has nothing to re-measure.
    vi.setSystemTime(1_000_000 + REMEASURE_MIN_INTERVAL_MS + 1);
    const callsBefore = getSnapshot.mock.calls.length;

    // 8 MB of accepted growth — 16 amortization triggers — inside one window.
    const padBytes = MEASURE_AFTER_ACCEPTED_BYTES;
    for (let i = 0; i < 16; i++) {
      expect(evaluateAndRecord(guard, putMessage(`shape:${i}`, padBytes))).toBe(true);
    }
    expect(getSnapshot.mock.calls.length).toBe(callsBefore + 1);

    // The next window re-opens the budget, and only by one.
    vi.setSystemTime(1_000_000 + 2 * (REMEASURE_MIN_INTERVAL_MS + 1));
    for (let i = 16; i < 32; i++) {
      expect(evaluateAndRecord(guard, putMessage(`shape:${i}`, padBytes))).toBe(true);
    }
    expect(getSnapshot.mock.calls.length).toBe(callsBefore + 2);
  });

  it("re-measures an over-limit projection that has drifted, regardless of the window", () => {
    // The amortization throttle must not reach the correctness path: an
    // over-limit projection built from accepted-byte drift has to be checked
    // against the document, not guessed at, however recently we measured.
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const { guard, getSnapshot, closedSessions } = createGuard(snapshotOfBytes(1024));
    const callsBefore = getSnapshot.mock.calls.length;

    // Accept enough wire bytes to project past the cap, inside one window.
    expect(
      evaluateAndRecord(guard, putMessage("shape:a", MAX_ROOM_WRITE_BYTES - 4096)),
    ).toBe(true);

    // The next growth projects over the cap. The document is still tiny, so the
    // verification measures and admits it rather than closing the session.
    expect(evaluateAndRecord(guard, putMessage("shape:b", 8192))).toBe(true);
    expect(getSnapshot.mock.calls.length).toBeGreaterThan(callsBefore);
    expect(closedSessions).toEqual([]);
  });

  it("re-measures once a delete has made room again", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const { guard, getSnapshot, setSnapshot, closedSessions } = createGuard(
      snapshotOfBytes(MAX_ROOM_WRITE_BYTES),
    );

    // Full room: growth is refused from the exact measurement, no re-serialize.
    const callsBeforeFull = getSnapshot.mock.calls.length;
    expect(evaluateAndRecord(guard, putMessage("shape:b", 4096))).toBe(false);
    expect(getSnapshot.mock.calls.length).toBe(callsBeforeFull);
    const closedWhileFull = closedSessions.length;

    // A delete lands (always admitted) and actually shrinks the document.
    setSnapshot(snapshotOfBytes(1024));
    expect(evaluateAndRecord(guard, removeMessage("shape:a"))).toBe(true);

    // The next growth re-measures because the delete introduced drift, and the
    // room is writable again without waiting out any window.
    expect(evaluateAndRecord(guard, putMessage("shape:d", 4096))).toBe(true);
    expect(getSnapshot.mock.calls.length).toBeGreaterThan(callsBeforeFull);
    expect(closedSessions).toHaveLength(closedWhileFull);
  });
});

describe("RoomMessageGuard chunk assembly", () => {
  it("enforces one aggregate in-flight assembly budget across the room", () => {
    const { guard, closedSessions, closeReasons } = createGuard(
      snapshotOfBytes(1024),
      true,
      editorMeta(),
      true,
      20,
    );
    const secondSession = "user-2:efgh5678";
    guard.addSession(secondSession);

    expect(guard.evaluate(SESSION_ID, "1_abcdefghij").forward).toBeNull();
    expect(guard.evaluate(secondSession, "1_abcdefghijk").forward).toBeNull();

    // The second sender's message is well within the per-message maximum; the
    // room is what ran out. That close must be retryable, not INVALID_RECORD,
    // which the client treats as fatal.
    expect(closedSessions).toEqual([secondSession]);
    expect(closeReasons).toEqual([TLSyncErrorCloseEventReason.RATE_LIMITED]);
    guard.deleteSession(SESSION_ID);
    guard.deleteSession(secondSession);
  });

  it("keeps a chunked message past the per-message maximum fatal", () => {
    const { guard, closeReasons } = createGuard(snapshotOfBytes(1024));

    const oversized = "x".repeat(WHITEBOARD_CONFIG.MAX_CLIENT_MESSAGE_BYTES + 1);
    expect(guard.evaluate(SESSION_ID, `1_${oversized}`).forward).toBeNull();

    expect(closeReasons).toEqual([TLSyncErrorCloseEventReason.INVALID_RECORD]);
    guard.clearSessions();
  });

  it("closes sessions that abandon a partial tldraw message", () => {
    vi.useFakeTimers();
    const { guard, closedSessions, closeReasons } = createGuard(snapshotOfBytes(1024));

    // A chunk that does not complete a message forwards nothing: TLSyncRoom
    // sees the message only once this guard has assembled it whole and ruled.
    expect(guard.evaluate(SESSION_ID, '1_{"type":"')).toEqual(
      expect.objectContaining({ accept: false, forward: null }),
    );
    vi.advanceTimersByTime(30_000);

    expect(closedSessions).toEqual([SESSION_ID]);
    expect(closeReasons).toEqual([undefined]);
    guard.clearSessions();
  });

  it("cancels the deadline when the final chunk arrives", () => {
    vi.useFakeTimers();
    const { guard, closedSessions } = createGuard(snapshotOfBytes(1024));

    guard.evaluate(SESSION_ID, '1_{"type":"');
    guard.evaluate(SESSION_ID, '0_ping"}');
    vi.advanceTimersByTime(30_000);

    expect(closedSessions).toEqual([]);
    guard.clearSessions();
  });

  it("keeps malformed completed records fatal", () => {
    const { guard, closeReasons } = createGuard(snapshotOfBytes(1024));

    expect(guard.evaluate(SESSION_ID, "not-json").accept).toBe(false);

    expect(closeReasons).toEqual(["INVALID_RECORD"]);
  });

  it("forwards the reassembled message, not the chunk it completed", () => {
    const { guard } = createGuard(snapshotOfBytes(1024));
    const whole = removeMessage();
    const split = Math.floor(whole.length / 2);

    expect(guard.evaluate(SESSION_ID, `1_${whole.slice(0, split)}`).forward).toBeNull();
    const decision = guard.evaluate(SESSION_ID, `0_${whole.slice(split)}`);

    expect(decision.accept).toBe(true);
    expect(decision.forward).toEqual({ message: JSON.parse(whole), presence: null });
  });
});

describe("RoomMessageGuard viewer pushes", () => {
  function viewerMeta(): SessionMeta {
    return { ...editorMeta(), connectedReadonly: true, capabilities: { ...editorMeta().capabilities, canEditWhiteboard: false, canManageWhiteboard: false } };
  }

  // tldraw skips a readonly session's document ops and answers the push with
  // `discard`, which rolls the viewer's edit back (pinned in
  // tldraw-contract.test.ts). The guard hands the push on whole, and neither
  // budgets nor judges a diff that cannot land.
  it("admits a viewer's push without charging or judging its diff", () => {
    const { guard, closedSessions } = createGuard(snapshotOfBytes(1024), false, viewerMeta());

    const decision = guard.evaluate(SESSION_ID, putMessage());

    expect(decision.accept).toBe(true);
    expect(decision.forward?.message).toEqual(JSON.parse(putMessage()));
    expect(decision.sizeEffect).toBe("no-mutation");
    expect(decision.hasPageFrameMutation).toBe(false);
    expect(closedSessions).toEqual([]);
  });

  it("binds a viewer's presence to the authenticated identity", () => {
    const { guard } = createGuard(snapshotOfBytes(1024), false, viewerMeta());
    const presenceOnly = JSON.stringify({
      type: "push",
      clientClock: 3,
      presence: ["patch", { cursor: ["put", { x: 1, y: 2 }] }],
    });

    const decision = guard.evaluate(SESSION_ID, presenceOnly);

    expect(decision.accept).toBe(true);
    expect(decision.forward).toEqual({
      message: { type: "push", clientClock: 3 },
      presence: [
        "patch",
        {
          cursor: ["put", { x: 1, y: 2 }],
          userId: ["put", "user:user-1"],
          userName: ["put", "Alice"],
        },
      ],
    });
  });
});

describe("RoomMessageGuard presence", () => {
  it("replaces spoofed identity fields for writable sessions", () => {
    const { guard } = createGuard(snapshotOfBytes(1024));
    const decision = guard.evaluate(SESSION_ID, JSON.stringify({
      type: "push",
      clientClock: 5,
      presence: [
        "put",
        {
          typeName: "instance_presence",
          id: "instance_presence:attacker",
          userId: "user:host",
          userName: "Meeting Host",
        },
      ],
    }));

    expect(decision.accept).toBe(true);
    expect(decision.forward?.presence?.[1]).toMatchObject({
      userId: "user:user-1",
      userName: "Alice",
    });
  });

  it("closes a session whose presence push has no clock to answer", () => {
    const { guard, closeReasons } = createGuard(snapshotOfBytes(1024));

    const decision = guard.evaluate(
      SESSION_ID,
      JSON.stringify({ type: "push", presence: ["patch", { cursor: ["put", { x: 1, y: 2 }] }] }),
    );

    expect(decision.accept).toBe(false);
    expect(closeReasons).toEqual(["INVALID_RECORD"]);
  });

  // The wire is JSON, so a `__proto__` key parses to an own property and would
  // reach sync-core's `applyObjectDiff` as `newObject["__proto__"] = value`,
  // setting a record's prototype. The document lane rejects such keys; the
  // presence lane must too. Built from a raw string because a `__proto__` in an
  // object literal sets the prototype instead of an own key.
  it("rejects a presence patch carrying a prototype-polluting key", () => {
    const { guard, closedSessions, closeReasons } = createGuard(snapshotOfBytes(1024));

    const decision = guard.evaluate(
      SESSION_ID,
      '{"type":"push","clientClock":5,"presence":["patch",{"__proto__":{"polluted":["put",true]}}]}',
    );

    expect(decision.accept).toBe(false);
    expect(decision.forward).toBeNull();
    expect(closedSessions).toEqual([SESSION_ID]);
    expect(closeReasons).toEqual([TLSyncErrorCloseEventReason.INVALID_RECORD]);
  });

  it("rejects a prototype-polluting key nested inside a presence value", () => {
    const { guard, closedSessions } = createGuard(snapshotOfBytes(1024));

    const decision = guard.evaluate(
      SESSION_ID,
      '{"type":"push","clientClock":5,"presence":["put",{"typeName":"instance_presence","id":"instance_presence:v","meta":{"__proto__":{"x":1}}}]}',
    );

    expect(decision.accept).toBe(false);
    expect(closedSessions).toEqual([SESSION_ID]);
  });

  it("rejects a read-only guest's prototype-polluting presence-only push", () => {
    const viewerMeta: SessionMeta = { ...editorMeta(), connectedReadonly: true };
    const { guard, closedSessions, closeReasons } = createGuard(
      snapshotOfBytes(1024),
      false,
      viewerMeta,
    );

    const decision = guard.evaluate(
      SESSION_ID,
      '{"type":"push","clientClock":5,"presence":["patch",{"__proto__":{"polluted":["put",true]}}]}',
    );

    // The push carries presence, so it is judged before the readonly document
    // branch and rejected fail-closed like any invalid record.
    expect(decision.accept).toBe(false);
    expect(decision.forward).toBeNull();
    expect(closedSessions).toEqual([SESSION_ID]);
    expect(closeReasons).toEqual([TLSyncErrorCloseEventReason.INVALID_RECORD]);
  });
});

describe("RoomMessageGuard revoked edit access", () => {
  // A session whose authority is being narrowed is still a writable tldraw
  // session; the room's authorizers refuse its writes record by record and
  // its client rolls them back. The guard neither charges nor closes it.
  it("leaves a revoked editor's writes to the authorizers, unbudgeted", () => {
    const { guard, closeReasons } = createGuard(snapshotOfBytes(1024), false);

    const decision = guard.evaluate(SESSION_ID, putMessage());

    expect(decision.accept).toBe(true);
    expect(decision.sizeEffect).toBe("no-mutation");
    expect(closeReasons).toEqual([]);
  });
});

describe("RoomMessageGuard document lifecycle", () => {
  it("leaves writes to an archiving document to the authorizers, unbudgeted", () => {
    const { guard, closeReasons } = createGuard(
      snapshotOfBytes(1024),
      true,
      editorMeta(),
      false,
    );

    const decision = guard.evaluate(SESSION_ID, putMessage());
    expect(decision.accept).toBe(true);
    expect(decision.sizeEffect).toBe("no-mutation");
    expect(closeReasons).toEqual([]);
  });

  it("still accepts protocol messages that do not mutate the document", () => {
    const { guard, closeReasons } = createGuard(
      snapshotOfBytes(1024),
      true,
      editorMeta(),
      false,
    );

    expect(guard.evaluate(
      SESSION_ID,
      JSON.stringify({ type: "connect", connectRequestId: "r1", protocolVersion: 7 }),
    ).accept).toBe(true);
    expect(closeReasons).toEqual([]);
  });
});

describe("RoomMessageGuard connect-request detection", () => {
  it("flags the client's connect request", () => {
    const { guard } = createGuard(snapshotOfBytes(1024));

    const decision = guard.evaluate(
      SESSION_ID,
      JSON.stringify({ type: "connect", connectRequestId: "r1", protocolVersion: 7 }),
    );

    expect(decision.accept).toBe(true);
    expect(decision.isConnectRequest).toBe(true);
  });

  it("drops duplicate connect requests after the handshake", () => {
    const { guard } = createGuard(snapshotOfBytes(1024));
    const connect = JSON.stringify({
      type: "connect",
      connectRequestId: "r1",
      protocolVersion: 7,
    });

    expect(guard.evaluate(SESSION_ID, connect).accept).toBe(true);
    expect(guard.evaluate(SESSION_ID, connect)).toMatchObject({
      accept: false,
      isConnectRequest: true,
    });
  });

  it("allows a fresh handshake after the session is replaced", () => {
    const { guard } = createGuard(snapshotOfBytes(1024));
    const connect = JSON.stringify({ type: "connect" });

    expect(guard.evaluate(SESSION_ID, connect).accept).toBe(true);
    guard.deleteSession(SESSION_ID);
    guard.addSession(SESSION_ID);
    expect(guard.evaluate(SESSION_ID, connect).accept).toBe(true);
  });

  it("flags a connect request that arrived chunked", () => {
    const { guard } = createGuard(snapshotOfBytes(1024));

    expect(guard.evaluate(SESSION_ID, '1_{"type":"con').isConnectRequest).toBe(false);
    expect(guard.evaluate(SESSION_ID, '0_nect"}').isConnectRequest).toBe(true);
  });

  it("does not flag ordinary traffic, including records that embed the marker", () => {
    const { guard } = createGuard(snapshotOfBytes(1024));

    expect(guard.evaluate(SESSION_ID, JSON.stringify({ type: "ping" })).isConnectRequest)
      .toBe(false);
    // A shape whose own meta says type:"connect" is user content, not a
    // handshake — the check reads the top-level protocol field only.
    const decision = guard.evaluate(
      SESSION_ID,
      JSON.stringify({
        type: "push",
        clientClock: 1,
        diff: {
          "shape:evil": [
            "put",
            { typeName: "shape", type: "geo", id: "shape:evil", meta: { type: "connect" } },
          ],
        },
      }),
    );
    expect(decision.accept).toBe(true);
    expect(decision.isConnectRequest).toBe(false);
  });
});
