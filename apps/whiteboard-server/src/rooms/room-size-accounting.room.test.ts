import { whiteboardTLSchema } from "@orbmeet/whiteboard-core/room-schema";
import * as syncCore from "@tldraw/sync-core";
const { getTlsyncProtocolVersion } = syncCore as unknown as { getTlsyncProtocolVersion(): number };
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { WhiteboardRoomId } from "@orbmeet/whiteboard-core/whiteboard-room-id";
import { createTestRoom } from "./room-test-support.ts";
import type { RoomMessageGuard } from "./room-message-guard.ts";
import type { SocketSession, TldrawSocket } from "./room-types.ts";

const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it("charges a push at least what storing it adds, author stamps included", () => {
  // Between re-measures the room trusts its running estimate as an upper
  // bound on its stored size. Small shapes from an editor with a long name are
  // where what is stored outgrows what was sent the most.
  vi.useFakeTimers({ toFake: ["Date"] });
  const whiteboardRoomId = "meet-size" as WhiteboardRoomId;
  const dir = mkdtempSync(join(tmpdir(), "orbmeet-room-size-"));
  dirs.push(dir);
  const room = createTestRoom(whiteboardRoomId, dir, vi.fn(), { whiteboardId: "wb_size" });
  const editor: SocketSession = {
    tldrawSessionId: "editor-1:tab",
    userId: "editor-1",
    userName: "N".repeat(256),
    role: "participant",
    capabilities: { canEditWhiteboard: true, canControlSurface: false, canManageWhiteboard: false },
    grantPrincipal: { type: "user", id: "editor-1" },
    whiteboardRoomId,
    connectionId: "conn-editor-1",
    documentId: "wb_size",
  };
  room.handleConnect({ readyState: 1, send: () => {}, close: () => {} } satisfies TldrawSocket, editor);
  room.handleMessage(editor.tldrawSessionId, JSON.stringify({
    type: "connect",
    protocolVersion: getTlsyncProtocolVersion(),
    schema: whiteboardTLSchema.serialize(),
    connectRequestId: "c",
    lastServerClock: -1,
  }));
  const guard = (room as unknown as { messageGuard: RoomMessageGuard }).messageGuard;
  const storedBytes = () => Buffer.byteLength(JSON.stringify(room.document.currentSnapshot()), "utf8");

  for (let push = 1; push <= 5; push += 1) {
    const diff: Record<string, unknown> = {};
    for (let i = 0; i < 200; i += 1) {
      const id = `shape:g${push}-${i}`;
      diff[id] = ["put", {
        id, typeName: "shape", type: "group", x: 0, y: 0, rotation: 0, index: "a1",
        parentId: "page:page", isLocked: false, opacity: 1, meta: {}, props: {},
      }];
    }
    room.handleMessage(editor.tldrawSessionId, JSON.stringify({ type: "push", clientClock: push, diff }));
  }

  expect(room.document.currentSnapshot().documents.filter(({ state }) => state.typeName === "shape").length)
    .toBeGreaterThanOrEqual(1000);
  expect(guard.getEstimatedRoomBytes()).toBeGreaterThanOrEqual(storedBytes());
});
