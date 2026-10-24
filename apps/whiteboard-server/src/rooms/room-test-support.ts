// Shared construction for tests that build rooms directly.

import {
  SYNC_COMMAND_FAILURES,
  type AuthorityClaim,
  type AuthorityVerdict,
  type SyncCommandFailureReason,
} from "@orbmeet/whiteboard-core/sync-commands";
import type { WhiteboardRoomId } from "@orbmeet/whiteboard-core/whiteboard-room-id";
import type { AuthorityValidator } from "../http/authority-client.ts";
import { createMemoryObjectStore } from "../persistence/r2.ts";
import { SnapshotStore } from "../persistence/snapshot-store.ts";
import { Room, type RoomDependencies } from "./room.ts";

/** An authority that answers `verdict` (default: every claim is active). */
export function fakeAuthority(
  verdict: AuthorityVerdict | "unavailable" | ((claim: AuthorityClaim) => AuthorityVerdict) = "active",
): AuthorityValidator & { calls: AuthorityClaim[][] } {
  const calls: AuthorityClaim[][] = [];
  return {
    calls,
    async verdicts(_whiteboardRoomId, claims) {
      calls.push(claims);
      if (verdict === "unavailable") return "unavailable";
      return claims.map((claim) => (typeof verdict === "function" ? verdict(claim) : verdict));
    },
  };
}

function testRoomDependencies(overrides: Partial<RoomDependencies> = {}): RoomDependencies {
  return {
    snapshots: new SnapshotStore(createMemoryObjectStore()),
    authority: fakeAuthority(),
    whiteboardId: "wb_test",
    ...overrides,
  };
}

export function createTestRoom(
  whiteboardRoomId: string,
  dataDir: string,
  onEmpty: () => void = () => {},
  overrides: Partial<RoomDependencies> = {},
): Room {
  return new Room(whiteboardRoomId as WhiteboardRoomId, dataDir, onEmpty, testRoomDependencies(overrides));
}

/** The HTTP status a command result maps to, for tests written against statuses. */
export function commandStatus(result: { ok: true } | { ok: false; reason: SyncCommandFailureReason }): number {
  return result.ok ? 200 : SYNC_COMMAND_FAILURES[result.reason];
}
