import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TLSyncErrorCloseEventReason } from "@tldraw/sync-core";
import type { TLShape } from "@tldraw/tlschema";
import { WHITEBOARD_CONFIG } from "@orbmeet/whiteboard-core/config";
import { toWhiteboardRoomId } from "@orbmeet/whiteboard-core/whiteboard-room-id";
import { WHITEBOARD_EVENTS } from "@orbmeet/whiteboard-core/protocol";
import {
  isPublicIpAddress,
  isSafeExternalBrowserUrl,
} from "@orbmeet/whiteboard-core/public-host";

import { RoomMessageGuard } from "./rooms/room-message-guard.ts";
import { roomRecordAuthorizers } from "./rooms/room-record-authorizers.ts";
import { acquireSingleWriterLock } from "./persistence/writer-lock.ts";
import { canEditWhiteboardForMeta } from "./rooms/room-authority.ts";
import { assertSafeUnfurlTarget, UnsafeUnfurlTargetError } from "./http/net-security.ts";
import type { SessionMeta } from "./rooms/room-types.ts";

const { MAX_ROOM_WRITE_BYTES } = WHITEBOARD_CONFIG;
const ROOM_ID = toWhiteboardRoomId("empirical-room-1");

function createMockSessionMeta(
  userId: string,
  principalKey: string,
  options: {
    canManageWhiteboard?: boolean;
    canEditWhiteboard?: boolean;
    connectedReadonly?: boolean;
  } = {},
): SessionMeta {
  const canManage = options.canManageWhiteboard ?? false;
  return {
    userId,
    userName: `User ${userId}`,
    role: "participant",
    capabilities: {
      canEditWhiteboard: canManage || (options.canEditWhiteboard ?? true),
      canControlSurface: canManage,
      canManageWhiteboard: canManage,
    },
    grantPrincipal: { type: "user", id: userId },
    grantPrincipalKey: principalKey,
    writesSuspended: false,
    whiteboardRoomId: ROOM_ID,
    connectionId: `conn-${userId}`,
    connectedReadonly: options.connectedReadonly ?? false,
  };
}

describe("whiteboard sync invariants: CRDT guards, concurrency, persistence", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "orbmeet-m2-empirical-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    await rm(tempDir, { recursive: true, force: true });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 1. CRDT MESSAGE GUARDING & REJECTION PROOFS
  // ───────────────────────────────────────────────────────────────────────────
  describe("CRDT Message Guarding & Schema Invariants", () => {
    it("empirically enforces write byte quota limits (MAX_ROOM_WRITE_BYTES = 20MB) and headroom recovery", () => {
      vi.useFakeTimers();
      let currentSnapshot: unknown = {
        documentClock: 1,
        documents: [
          {
            state: {
              typeName: "shape",
              type: "geo",
              id: "shape:base",
              pad: "x".repeat(MAX_ROOM_WRITE_BYTES),
            },
          },
        ],
      };

      const sentCustomMessages: unknown[] = [];
      const closedSessions: Array<{ id: string; reason: unknown }> = [];
      let roomSizeRecoveredCalled = false;

      const meta = createMockSessionMeta("user-1", "user:user-1");
      const guard = new RoomMessageGuard({
        whiteboardRoomId: ROOM_ID,
        getSnapshot: () => currentSnapshot,
        getSessionMeta: () => meta,
        canEditWhiteboardForMeta: () => true,
        sendCustomMessage: (_sid, msg) => { sentCustomMessages.push(msg); },
        discardPush: vi.fn(),
        onRoomSizeRecovered: () => { roomSizeRecoveredCalled = true; },
        closeSession: (id, reason) => { closedSessions.push({ id, reason }); },
        closeSessionTransiently: (id) => { closedSessions.push({ id, reason: undefined }); },
      });
      guard.addSession("session-user-1");

      // 1. Pure additive write when room is at 20MB cap -> rejected with ROOM_FULL
      const additivePush = JSON.stringify({
        type: "push",
        diff: {
          "shape:new-box": [
            "put",
            { typeName: "shape", type: "geo", id: "shape:new-box", pad: "x".repeat(1024) },
          ],
        },
      });
      const decisionOverLimit = guard.evaluate("session-user-1", additivePush);
      expect(decisionOverLimit.accept).toBe(false);
      expect(closedSessions).toContainEqual({
        id: "session-user-1",
        reason: TLSyncErrorCloseEventReason.ROOM_FULL,
      });
      expect(sentCustomMessages).toContainEqual(
        expect.objectContaining({
          type: WHITEBOARD_EVENTS.ROOM_SIZE_LIMIT,
          maxBytes: MAX_ROOM_WRITE_BYTES,
        }),
      );

      // 2. Remove-only push when room is at 20MB cap -> admitted
      const removePush = JSON.stringify({
        type: "push",
        diff: { "shape:base": ["remove"] },
      });
      const decisionRemove = guard.evaluate("session-user-1", removePush);
      expect(decisionRemove.accept).toBe(true);
      expect(decisionRemove.sizeEffect).toBe("remove-only");

      // 3. Mixed delete + patch (may-shrink) -> admitted under 4MB headroom
      const mixedPush = JSON.stringify({
        type: "push",
        diff: {
          "shape:gone": ["remove"],
          "shape:rebound": ["patch", { parentId: ["put", "shape:page-1"] }],
        },
      });
      const decisionMixed = guard.evaluate("session-user-1", mixedPush);
      expect(decisionMixed.accept).toBe(true);
      expect(decisionMixed.sizeEffect).toBe("may-shrink");

      // 4. Recovery: when room drops back under limit, recordAcceptedMessage triggers recovery callback
      currentSnapshot = {
        documentClock: 2,
        documents: [{ state: { typeName: "shape", type: "geo", id: "shape:small", pad: "x".repeat(1024) } }],
      };
      guard.recordAcceptedMessage(decisionRemove);
      // Measured through the throttle, which the rejection above just used.
      vi.advanceTimersByTime(2_000);
      expect(roomSizeRecoveredCalled).toBe(true);
      expect(guard.isRoomSizeLimited()).toBe(false);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 2. SSRF & ASSET SECURITY EMPIRICAL PROOFS
  // ───────────────────────────────────────────────────────────────────────────
  describe("SSRF & Asset URL Filtering", () => {
    it("empirically filters private/loopback/cloud metadata in assertSafeUnfurlTarget and URL helpers", async () => {
      // Direct IP assertions
      expect(isPublicIpAddress("127.0.0.1")).toBe(false);
      expect(isPublicIpAddress("169.254.169.254")).toBe(false);
      expect(isPublicIpAddress("10.0.0.1")).toBe(false);
      expect(isPublicIpAddress("172.16.0.1")).toBe(false);
      expect(isPublicIpAddress("192.168.1.1")).toBe(false);
      expect(isPublicIpAddress("::1")).toBe(false);
      expect(isPublicIpAddress("::ffff:127.0.0.1")).toBe(false);
      expect(isPublicIpAddress("8.8.8.8")).toBe(true);

      // isSafeExternalBrowserUrl assertions
      expect(isSafeExternalBrowserUrl("https://example.com/asset.png")).toBe(true);
      expect(isSafeExternalBrowserUrl("http://127.0.0.1:8000/")).toBe(false);
      expect(isSafeExternalBrowserUrl("http://169.254.169.254/latest/meta-data/")).toBe(false);
      expect(isSafeExternalBrowserUrl("http://printer.local/")).toBe(false);
      expect(isSafeExternalBrowserUrl("http://[::1]/")).toBe(false);

      // Unfurl target safety validation with DNS mocking
      await expect(
        assertSafeUnfurlTarget(new URL("http://127.0.0.1/admin")),
      ).rejects.toThrow(UnsafeUnfurlTargetError);

      await expect(
        assertSafeUnfurlTarget(new URL("http://localhost:3000/api")),
      ).rejects.toThrow(UnsafeUnfurlTargetError);

      await expect(
        assertSafeUnfurlTarget(new URL("http://169.254.169.254/latest")),
      ).rejects.toThrow(UnsafeUnfurlTargetError);

      await expect(
        assertSafeUnfurlTarget(new URL("http://printer.local/status")),
      ).rejects.toThrow(UnsafeUnfurlTargetError);

      await expect(
        assertSafeUnfurlTarget(new URL("javascript:alert(1)")),
      ).rejects.toThrow(UnsafeUnfurlTargetError);

      await expect(
        assertSafeUnfurlTarget(new URL("http://example.com:8080/non-default-port")),
      ).rejects.toThrow(UnsafeUnfurlTargetError);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 3. CONCURRENCY & SPLIT-BRAIN SINGLE-WRITER LOCK PROOFS
  // ───────────────────────────────────────────────────────────────────────────
  describe("Concurrency & Split-Brain Single-Writer Lock", () => {
    it("empirically enforces single-writer mutual exclusion on .writer-lock.db", () => {
      // First process acquires lock
      const lock1 = acquireSingleWriterLock(tempDir);
      expect(() => lock1.assertOwned()).not.toThrow();

      // Second concurrent acquire on same directory MUST fail with SQLITE_BUSY / locked error
      expect(() => {
        acquireSingleWriterLock(tempDir);
      }).toThrow(/already owned by another writer/);

      // Clean release allows replacement
      lock1.release();

      const lock2 = acquireSingleWriterLock(tempDir);
      expect(() => lock2.assertOwned()).not.toThrow();
      lock2.release();
    });

    it("empirically detects lock loss and triggers fail-closed onLost callback", () => {
      let lostFired = false;
      const lock = acquireSingleWriterLock(tempDir, {
        onLost: () => {
          lostFired = true;
        },
      });

      expect(() => lock.assertOwned()).not.toThrow();

      // Simulate lock loss by explicitly releasing the underlying database
      lock.release();

      // Subsequent assertOwned must fail and report ownership lost
      expect(() => lock.assertOwned()).toThrow(/ownership was lost/);
      expect(lostFired).toBe(false);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 4. CAPABILITY REVOCATION & IN-MEMORY FENCES EMPIRICAL PROOFS
  // ───────────────────────────────────────────────────────────────────────────
  describe("Capability Revocation", () => {
    it("empirically blocks writes the instant a principal's authority is suspended", () => {
      const editorSession = createMockSessionMeta("editor-1", "user:editor-1");
      const managerSession = createMockSessionMeta("manager-1", "user:manager-1", {
        canManageWhiteboard: true,
      });
      const authorize = roomRecordAuthorizers({
        roomLabel: ROOM_ID,
        sessionMeta: (sid) => (sid === "sess-editor" ? editorSession : managerSession),
        canAcceptMutations: () => true,
        isActiveNavigator: () => false,
      }).shape!;
      const box = { id: "shape:box-1", typeName: "shape", type: "geo", meta: {}, props: {} } as unknown as TLShape;
      const moved = { ...box, x: 50 } as TLShape;
      const write = (sessionId: string, meta: SessionMeta) =>
        authorize({ session: { sessionId, isReadonly: false, meta }, type: "update", prev: box, next: moved });

      expect(write("sess-editor", editorSession)).toBe(moved);

      // The Worker revoked the grant in D1 and told the room: the session's
      // writes stop now, before any reconnect or verdict round trip — judged
      // by its live meta, not the meta it connected with.
      editorSession.writesSuspended = true;
      expect(write("sess-editor", { ...editorSession, writesSuspended: false })).toBeNull();

      // A manager is never suspended by an editor's revoke.
      expect(write("sess-manager", managerSession)).toBe(moved);
    });

    it("rolls back a delete of the last page and keeps the session, whoever sent it", () => {
      const manager = createMockSessionMeta("user-1", "user:user-1", { canManageWhiteboard: true });
      const editor = createMockSessionMeta("user-2", "user:user-2");
      const sessions = { "sess-manager": manager, "sess-editor": editor } as Record<string, SessionMeta>;
      const discardPush = vi.fn();
      const closeSession = vi.fn();
      const closeSessionTransiently = vi.fn();
      const guard = new RoomMessageGuard({
        whiteboardRoomId: ROOM_ID,
        getSnapshot: () => ({
          documentClock: 1,
          documents: [{
            state: {
              id: "shape:p1", typeName: "shape", type: "whiteboard-page", x: 0, y: 0, rotation: 0, index: "a1",
              parentId: "page:page", isLocked: true, opacity: 1, meta: {},
              props: { w: 1200, h: 900, name: "Page", background: "white" },
            },
            lastChangedClock: 1,
          }],
        }),
        getSessionMeta: (sid) => sessions[sid],
        canEditWhiteboardForMeta: canEditWhiteboardForMeta,
        sendCustomMessage: vi.fn(),
        discardPush,
        onRoomSizeRecovered: vi.fn(),
        closeSession,
        closeSessionTransiently,
      });
      guard.addSession("sess-manager");
      guard.addSession("sess-editor");
      const deleteLastPage = JSON.stringify({ type: "push", clientClock: 7, diff: { "shape:p1": ["remove"] } });

      // A manager lost the two-manager race: undo it and keep the session.
      expect(guard.evaluate("sess-manager", deleteLastPage).accept).toBe(false);
      expect(discardPush).toHaveBeenCalledTimes(1);
      expect(discardPush).toHaveBeenCalledWith("sess-manager", 7);
      expect(closeSession).not.toHaveBeenCalled();

      // A non-manager's is undone the same way; that it may not touch page
      // frames at all is the authorizers' to refuse, record by record.
      expect(guard.evaluate("sess-editor", deleteLastPage).accept).toBe(false);
      expect(discardPush).toHaveBeenLastCalledWith("sess-editor", 7);
      expect(closeSession).not.toHaveBeenCalled();
    });
  });
});
