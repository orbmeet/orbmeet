import { whiteboardTLSchema } from "@orbmeet/whiteboard-core/room-schema";
import {
  createEmptyWhiteboardRoomSnapshot,
  isDocumentRecordId,
  validateWhiteboardRoomSnapshot,
} from "@orbmeet/whiteboard-core/room-snapshot-validation";
import * as syncCore from "@tldraw/sync-core";
const { getTlsyncProtocolVersion } = syncCore as unknown as { getTlsyncProtocolVersion(): number };
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestRoom } from "./room-test-support.ts";
import { classifyIncomingDiff } from "./page-frame-guard.ts";
import type { TldrawSocket, SocketSession } from "./room-types.ts";
import type { WhiteboardRoomId } from "@orbmeet/whiteboard-core/whiteboard-room-id";

const tempDirs: string[] = [];
function makeDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "orbmeet-room-record-id-"));
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

function makeWsData(whiteboardRoomId: WhiteboardRoomId, userId: string): SocketSession {
  return {
    tldrawSessionId: `${userId}:sess`,
    userId,
    userName: `User ${userId}`,
    role: "participant",
    capabilities: {
      canEditWhiteboard: true,
      canControlSurface: true,
      canManageWhiteboard: true,
    },
    grantPrincipal: { type: "user", id: userId },
    whiteboardRoomId,
    connectionId: `conn-${userId}`,
  };
}

/** A schema-valid geo shape; its own `id` is independent of the storage key. */
function geoShape(id: string): Record<string, unknown> {
  return {
    id,
    typeName: "shape",
    type: "geo",
    x: 0,
    y: 0,
    rotation: 0,
    index: "a1",
    parentId: "page:page",
    isLocked: false,
    opacity: 1,
    meta: {},
    props: {
      geo: "rectangle",
      w: 100,
      h: 100,
      growY: 0,
      scale: 1,
      flipX: false,
      flipY: false,
      dash: "draw",
      size: "m",
      fill: "none",
      color: "black",
      labelColor: "black",
      font: "draw",
      align: "middle",
      verticalAlign: "middle",
      url: "",
      richText: { type: "doc", content: [] },
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("live admission enforces the snapshot validator's record-id predicate", () => {
  // Ids the guard once admitted and the persistence validator refused.
  const refusedIds = {
    over512: "shape:" + "x".repeat(600),
    noColon: "tombstone-orphan",
    sessionScoped: "camera:rogue",
    notAType: "pointer:rogue",
  } as const;

  it("rejects over-length and non-document ids with the invalid-record-id verdict", () => {
    const verdictFor = (id: string, op: unknown[]) =>
      classifyIncomingDiff(
        { type: "push", clientClock: 1, diff: { [id]: op } },
        new Set(),
      );
    for (const id of Object.values(refusedIds)) {
      expect(verdictFor(id, ["put", geoShape(id)])).toBe("invalid-record-id");
      expect(verdictFor(id, ["remove"])).toBe("invalid-record-id");
    }
  });

  it("refuses a put stored under a key other than its record's id", () => {
    // sync-core stores a put under the key it arrives with, so a valid record
    // id inside proves nothing about the key.
    expect(classifyIncomingDiff(
      { type: "push", clientClock: 1, diff: { [refusedIds.over512]: ["put", geoShape("shape:real-1")] } },
      new Set(),
    )).toBe("invalid-record-id");
    expect(classifyIncomingDiff(
      { type: "push", clientClock: 1, diff: { "shape:a": ["put", geoShape("shape:b")] } },
      new Set(),
    )).toBe("invalid-record-id");
  });

  it("leaves ordinary ids and the existing structural rejections untouched", () => {
    expect(classifyIncomingDiff(
      { type: "push", clientClock: 1, diff: { "shape:abc": ["patch", { x: ["put", 5] }] } },
      new Set(),
    )).toBe("allow");
    expect(classifyIncomingDiff(
      { type: "push", clientClock: 2, diff: { "shape:abc": ["remove"] } },
      new Set(),
    )).toBe("allow");
    // A prototype key is refused outright. (`__proto__` as an own key has to
    // be built through JSON — a literal would set the prototype.)
    expect(classifyIncomingDiff(
      JSON.parse('{ "type": "push", "clientClock": 4, "diff": { "__proto__": ["remove"] } }'),
      new Set(),
    )).toBe("forbidden");
  });

  it("judges ids with the same predicate the persistence validator uses on tombstones", () => {
    // One source of truth, asserted from both directions: the shared predicate
    // and the snapshot validator must agree for every id class.
    const base = createEmptyWhiteboardRoomSnapshot();
    for (const id of [...Object.values(refusedIds), "shape:ok"]) {
      const snapshot = { ...structuredClone(base), tombstones: { [id]: 5 } };
      const validated = validateWhiteboardRoomSnapshot(snapshot).ok;
      expect(isDocumentRecordId(id)).toBe(validated);
    }
  });
});

describe("a poison-record-id flow can no longer be produced end-to-end", () => {
  it("NAKs the put and remove of an over-length id instead of storing it", async () => {
    const whiteboardRoomId = "meet-record-id-1" as WhiteboardRoomId;
    const room = createTestRoom(whiteboardRoomId, makeDataDir(), vi.fn());
    const storedBody = () => JSON.stringify(room.document.currentSnapshot());
    const socket = makeSocket();
    const data = makeWsData(whiteboardRoomId, "editor-1");
    room.handleConnect(socket, data);
    room.handleMessage(data.tldrawSessionId, JSON.stringify({
      type: "connect",
      protocolVersion: getTlsyncProtocolVersion(),
      schema: whiteboardTLSchema.serialize(),
      connectRequestId: "confirm",
      lastServerClock: -1,
    }));
    expect(socket.closed).toHaveLength(0);

    const longId = "shape:" + "x".repeat(600);
    room.handleMessage(data.tldrawSessionId, JSON.stringify({
      type: "push",
      clientClock: 1,
      diff: { [longId]: ["put", geoShape(longId)] },
    }));
    room.handleMessage(data.tldrawSessionId, JSON.stringify({
      type: "push",
      clientClock: 2,
      diff: { [longId]: ["remove"] },
    }));
    // A valid record under a key that is not its id.
    room.handleMessage(data.tldrawSessionId, JSON.stringify({
      type: "push",
      clientClock: 3,
      diff: { "shape:key-a": ["put", geoShape("shape:real-1")] },
    }));

    // The session stays connected and each rejected push was answered on the
    // tldraw protocol with a discard, which is what makes the client roll the
    // poisoned records back instead of replaying them forever. Sync-core
    // batches protocol answers into debounced `data` envelopes, so let the
    // flush timer run before reading the socket.
    expect(socket.closed).toHaveLength(0);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const pushResults = socket.sent.flatMap((message) => {
      const parsed = JSON.parse(message) as { type: string; data?: Array<Record<string, unknown>> };
      return parsed.type === "data" ? parsed.data ?? [] : [parsed];
    }).filter((message) => message.type === "push_result");
    expect(pushResults).toHaveLength(3);
    for (const [index, result] of pushResults.entries()) {
      expect(result.action).toBe("discard");
      expect(result.clientClock).toBe(index + 1);
    }

    // The board's durable record, its room database, carries no trace of
    // the poison id: no document and no tombstone.
    const snapshot = JSON.parse(storedBody()) as {
      documents: unknown[];
      tombstones: Record<string, number>;
    };
    expect(
      snapshot.documents.some(
        (document) => ["shape:real-1", longId].includes((document as { state: { id: string } }).state.id),
      ),
    ).toBe(false);
    expect(Object.hasOwn(snapshot.tombstones, longId)).toBe(false);
    expect(validateWhiteboardRoomSnapshot(snapshot).ok).toBe(true);
    room.close();
  });

  it("admits a normal shape lifecycle (put, then remove) unchanged", async () => {
    const whiteboardRoomId = "meet-record-id-2" as WhiteboardRoomId;
    const room = createTestRoom(whiteboardRoomId, makeDataDir(), vi.fn());
    const storedBody = () => JSON.stringify(room.document.currentSnapshot());
    const socket = makeSocket();
    const data = makeWsData(whiteboardRoomId, "editor-1");
    room.handleConnect(socket, data);
    room.handleMessage(data.tldrawSessionId, JSON.stringify({
      type: "connect",
      protocolVersion: getTlsyncProtocolVersion(),
      schema: whiteboardTLSchema.serialize(),
      connectRequestId: "confirm",
      lastServerClock: -1,
    }));

    room.handleMessage(data.tldrawSessionId, JSON.stringify({
      type: "push",
      clientClock: 1,
      diff: { "shape:real-1": ["put", geoShape("shape:real-1")] },
    }));
    room.handleMessage(data.tldrawSessionId, JSON.stringify({
      type: "push",
      clientClock: 2,
      diff: { "shape:real-1": ["remove"] },
    }));

    // Accepted, not discarded: the ordinary lifecycle commits and lands in the
    // persisted snapshot as a legitimate tombstone the validator accepts.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const pushResults = socket.sent.flatMap((message) => {
      const parsed = JSON.parse(message) as { type: string; data?: Array<Record<string, unknown>> };
      return parsed.type === "data" ? parsed.data ?? [] : [parsed];
    }).filter((message) => message.type === "push_result");
    expect(pushResults.length).toBeGreaterThanOrEqual(1);
    expect(pushResults.every((result) => result.action !== "discard")).toBe(true);

    const lastBody = storedBody();
    const snapshot = JSON.parse(lastBody) as { tombstones: Record<string, number> };
    expect(Object.hasOwn(snapshot.tombstones, "shape:real-1")).toBe(true);
    expect(validateWhiteboardRoomSnapshot(
      JSON.parse(lastBody),
    ).ok).toBe(true);
    room.close();
  });
});
