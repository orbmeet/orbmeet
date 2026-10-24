import { describe, expect, it } from "vitest";
import {
  getLiveConnections,
  hasAnyLiveConnection,
  liveConnectionCount,
} from "./room-connections.ts";
import type { WhiteboardRole } from "@orbmeet/whiteboard-core/whiteboard-jwt";
import type { SessionMeta, TldrawSocket } from "./room-types.ts";

const OPEN = 1;
const CLOSED = 3;

function socket(readyState: number): TldrawSocket {
  return { readyState, send() {}, close() {} };
}

function meta(userId: string, role: WhiteboardRole, manager = false): SessionMeta {
  return {
    userId,
    userName: userId,
    role,
    capabilities: { canEditWhiteboard: manager, canControlSurface: manager, canManageWhiteboard: manager },
    grantPrincipal: { type: "user", id: userId },
    grantPrincipalKey: `user:${userId}`,
    writesSuspended: false,
    whiteboardRoomId: "meet-room",
    connectionId: `${userId}-conn`,
    connectedReadonly: !manager,
  };
}

// Models the room maps after a socket close: handleClose removes the closed
// session from both maps, while tldraw still keeps it in getSessions() for ~5s.
// These queries must reflect the *removed* truth, not the lingering one.
function maps(entries: Array<[string, number, SessionMeta]>) {
  const activeSockets = new Map<string, TldrawSocket>();
  const sessionMetaIndex = new Map<string, SessionMeta>();
  for (const [sid, readyState, m] of entries) {
    activeSockets.set(sid, socket(readyState));
    sessionMetaIndex.set(sid, m);
  }
  return { activeSockets, sessionMetaIndex };
}

describe("room connections", () => {
  it("counts only OPEN sockets for a user", () => {
    const { activeSockets, sessionMetaIndex } = maps([
      ["s1", OPEN, meta("alice", "participant", true)],
      ["s2", CLOSED, meta("alice", "participant", true)],
      ["s3", OPEN, meta("bob", "participant")],
    ]);
    expect(liveConnectionCount(activeSockets, sessionMetaIndex, "alice")).toBe(1);
    expect(liveConnectionCount(activeSockets, sessionMetaIndex, "bob")).toBe(1);
    expect(liveConnectionCount(activeSockets, sessionMetaIndex, "carol")).toBe(0);
  });

  it("treats a user with only non-OPEN sockets as fully left", () => {
    const { activeSockets, sessionMetaIndex } = maps([
      ["s1", CLOSED, meta("alice", "participant", true)],
    ]);
    expect(liveConnectionCount(activeSockets, sessionMetaIndex, "alice")).toBe(0);
    expect(hasAnyLiveConnection(activeSockets)).toBe(false);
  });

  it("counts any OPEN socket as a live connection", () => {
    const { activeSockets } = maps([["s1", OPEN, meta("bob", "participant")]]);
    expect(hasAnyLiveConnection(activeSockets)).toBe(true);
  });

  it("getLiveConnections pairs each OPEN socket with its tldraw session id, skipping closed and unmapped", () => {
    const activeSockets = new Map<string, TldrawSocket>([
      ["s1", socket(OPEN)],
      ["s2", socket(CLOSED)],
      ["s3", socket(OPEN)], // present in sockets but missing meta → skipped
    ]);
    const sessionMetaIndex = new Map<string, SessionMeta>([
      ["s1", meta("alice", "participant", true)],
      ["s2", meta("bob", "participant")],
    ]);
    expect(getLiveConnections(activeSockets, sessionMetaIndex)).toEqual([
      { tldrawSessionId: "s1", meta: meta("alice", "participant", true) },
    ]);
  });
});
