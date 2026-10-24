// A stand-in for the whiteboard sync server's command channel. Never used
// outside tests.
import { vi } from "vitest";
import {
  parseKeyring,
  SIGNATURE_HEADER,
  signatureTarget,
  verifySignedRequest,
} from "@orbmeet/primitives";
import {
  computeWhiteboardDocumentContentHash,
  computeWhiteboardSnapshotHash,
} from "@orbmeet/whiteboard-core/room-snapshot-validation";
import { extractSnapshotAssetKeys } from "@orbmeet/whiteboard-core/snapshot-assets";
import {
  parseSyncCommandPath,
  syncCommandFailure,
  type SnapshotMeta,
  type SyncCommandName,
  type SyncCommandRequest,
  type SyncCommandResult,
} from "@orbmeet/whiteboard-core/sync-commands";

import { TEST_MEDIA_NODE, TEST_MEDIA_NODE_ENTRY } from "./nodes";

const TEST_WHITEBOARD_URL = "https://whiteboard.test";
const TEST_JWT_KEYS = JSON.stringify({ jwt1: "j".repeat(40) });
export const TEST_COMMAND_KEYS = JSON.stringify({ cmd1: "c".repeat(40) });
export const TEST_CALLBACK_KEYS = JSON.stringify({ cb1: "b".repeat(40) });
/** Signs and verifies the tokens the Worker mints for TEST_MEDIA_NODE's whiteboard. */
export const TEST_JWT_KEYRING = parseKeyring(TEST_JWT_KEYS)!;

/** TEST_MEDIA_NODE's entry in NODES, running the whiteboard at TEST_WHITEBOARD_URL. */
const TEST_WHITEBOARD_NODE_ENTRY = {
  ...TEST_MEDIA_NODE_ENTRY,
  whiteboard: {
    url: TEST_WHITEBOARD_URL,
    jwt: JSON.parse(TEST_JWT_KEYS) as Record<string, string>,
    command: JSON.parse(TEST_COMMAND_KEYS) as Record<string, string>,
    callback: JSON.parse(TEST_CALLBACK_KEYS) as Record<string, string>,
  },
};

/**
 * The env fields that make the whiteboard configured: TEST_MEDIA_NODE running
 * the whiteboard at TEST_WHITEBOARD_URL. Spread after TEST_MEDIA_ENV, it
 * replaces that node's NODES entry with this one.
 */
export const TEST_WHITEBOARD_ENV = {
  NODES: JSON.stringify({ [TEST_MEDIA_NODE.id]: TEST_WHITEBOARD_NODE_ENTRY }),
} as const;

const COMMAND_KEYRING = parseKeyring(TEST_COMMAND_KEYS)!;

export interface ReceivedCommand {
  name: SyncCommandName;
  request: Record<string, unknown>;
}

type Handler<C extends SyncCommandName> = (
  request: SyncCommandRequest<C>,
) => SyncCommandResult<C> | Promise<SyncCommandResult<C>>;

/** A stable 32-character hash for `seed`, the shape D1's CHECK constraints require. */
export function fakeSnapshotHash(seed: string): string {
  let hash = 0x811c9dc5;
  for (const char of seed) hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193) >>> 0;
  return hash.toString(16).padStart(8, "0").repeat(4);
}

export function snapshotMeta(key: string, overrides: Partial<SnapshotMeta> = {}): SnapshotMeta {
  return {
    key,
    hash: fakeSnapshotHash(key),
    documentClock: 1,
    size: 100,
    assetKeys: [],
    ...overrides,
  };
}

/**
 * Stub `fetch` with a sync server that verifies each command's signature and
 * answers from `handlers`. A command without a handler answers `not_found`.
 */
export function installFakeSyncServer(
  handlers: { [C in SyncCommandName]?: Handler<C> } = {},
): { commands: ReceivedCommand[] } {
  const commands: ReceivedCommand[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      const name = parseSyncCommandPath(url.pathname);
      if (url.origin !== TEST_WHITEBOARD_URL || !name) {
        return new Response("Not found", { status: 404 });
      }
      const body = String(init?.body ?? "");
      const verification = await verifySignedRequest({
        header: new Headers(init?.headers).get(SIGNATURE_HEADER),
        method: init?.method ?? "GET",
        target: signatureTarget(url),
        body,
        keyring: COMMAND_KEYRING,
      });
      if (!verification.ok) return new Response("Unauthorized", { status: 401 });
      const request = JSON.parse(body) as Record<string, unknown>;
      commands.push({ name, request });
      const handler = handlers[name] as Handler<typeof name> | undefined;
      const result = handler
        ? await handler(request as never)
        : { ok: false, reason: "not_found", message: `no handler for ${name}` };
      return Response.json(result);
    }),
  );
  return { commands };
}

/**
 * Handlers that behave like the sync server over `objects` (a test bucket's
 * key → body map) and `rooms` (each board's live state, whiteboard id → body;
 * an absent board is empty). As on the sync server, a board's state is only
 * ever its room: R2 holds captures, revisions and restore points.
 */
export function emulatedSyncServer(
  objects: Map<string, string>,
  rooms: Map<string, string> = new Map(),
) {
  let documentClock = 100;
  const restoreResults = new Map<string, SyncCommandResult<"restore">>();
  const seeds = new Map<string, string>();
  const meta = async (key: string, body: string): Promise<SnapshotMeta> => ({
    key,
    hash: await computeWhiteboardSnapshotHash(body),
    documentClock: ++documentClock,
    size: new TextEncoder().encode(body).byteLength,
    assetKeys: extractSnapshotAssetKeys(JSON.parse(body)),
  });
  const parses = (body: string) => {
    try {
      JSON.parse(body);
      return true;
    } catch {
      return false;
    }
  };
  const roomBody = (whiteboardId: string) => rooms.get(whiteboardId) ?? JSON.stringify({ documents: [] });

  return {
    capture: async ({ whiteboardId, toKey, startBefore }) => {
      // Like the sync server: a copy that already landed is the command's
      // answer, and a command past its start deadline is never started.
      const copied = objects.get(toKey);
      if (copied !== undefined) return { ok: true, copy: await meta(toKey, copied) };
      if (startBefore !== undefined && Date.now() >= startBefore) {
        return syncCommandFailure("expired", "The command was not started in time");
      }
      const body = roomBody(whiteboardId);
      objects.set(toKey, body);
      return { ok: true, copy: await meta(toKey, body) };
    },
    seed: async ({ whiteboardId, commandId, source }) => {
      if (seeds.get(whiteboardId) === commandId) {
        return { ok: true, assetKeys: extractSnapshotAssetKeys(JSON.parse(roomBody(whiteboardId))) };
      }
      if (rooms.has(whiteboardId)) {
        return syncCommandFailure("conflict", "The destination whiteboard already has state");
      }
      const body = "key" in source ? objects.get(source.key) : roomBody(source.whiteboardId);
      if (body === undefined) return syncCommandFailure("not_found", "Source snapshot not found");
      if (!parses(body)) return syncCommandFailure("conflict", "Source snapshot is unreadable");
      rooms.set(whiteboardId, body);
      seeds.set(whiteboardId, commandId);
      return { ok: true, assetKeys: extractSnapshotAssetKeys(JSON.parse(body)) };
    },
    purge: async ({ whiteboardId }) => {
      rooms.delete(whiteboardId);
      return { ok: true, status: "purged" };
    },
    copySnapshot: async ({ sourceKey, destinationKey }) => {
      const body = objects.get(sourceKey);
      if (body === undefined) return syncCommandFailure("not_found", "Source snapshot not found");
      if (!parses(body)) return syncCommandFailure("conflict", "Source snapshot is unreadable");
      objects.set(destinationKey, body);
      return { ok: true, copy: await meta(destinationKey, body) };
    },
    readSnapshot: async ({ key }) => {
      const body = objects.get(key);
      if (body === undefined) return syncCommandFailure("not_found", "Snapshot not found");
      return { ok: true, snapshot: JSON.parse(body), meta: await meta(key, body) };
    },
    restore: async ({ commandId, startBefore, whiteboardId, sourceKey, restorePointKey }) => {
      // Like the sync server: a finished command answers with its first
      // result, and one past its start deadline is never started.
      const finished = restoreResults.get(commandId);
      if (finished) return finished;
      if (startBefore !== undefined && Date.now() >= startBefore) {
        return syncCommandFailure("expired", "The command was not started in time");
      }
      const target = objects.get(sourceKey);
      if (target === undefined) return syncCommandFailure("not_found", "Source snapshot not found");
      const replaced = roomBody(whiteboardId);
      const [replacedContent, targetContent] = await Promise.all([
        computeWhiteboardDocumentContentHash(JSON.parse(replaced)),
        computeWhiteboardDocumentContentHash(JSON.parse(target)),
      ]);
      if (targetContent === null) {
        return syncCommandFailure("conflict", "This revision's stored state could not be read");
      }
      let restorePoint: SnapshotMeta | null = null;
      if (replacedContent !== targetContent) {
        objects.set(restorePointKey, replaced);
        restorePoint = await meta(restorePointKey, replaced);
      }
      rooms.set(whiteboardId, target);
      const result = { ok: true as const, restorePoint };
      restoreResults.set(commandId, result);
      return result;
    },
  } satisfies { [C in SyncCommandName]?: Handler<C> };
}
