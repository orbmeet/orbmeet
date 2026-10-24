import type { RoomSnapshot } from "@tldraw/sync-core";
import { WHITEBOARD_CONFIG } from "@orbmeet/whiteboard-core/config";
import { SNAPSHOT_METADATA, readSnapshotMetadata } from "@orbmeet/whiteboard-core/document-keys";
import {
  computeWhiteboardSnapshotHash,
  validateWhiteboardSnapshotBody,
} from "@orbmeet/whiteboard-core/room-snapshot-validation";
import type { SnapshotMeta } from "@orbmeet/whiteboard-core/sync-commands";
import { extractSnapshotAssetKeys } from "@orbmeet/whiteboard-core/snapshot-assets";
import type { ObjectStore, StoredObject } from "./r2.ts";

/**
 * Stored whiteboard snapshots: revisions, restore points and Meeting captures.
 *
 * Every object here is written once and never changes, so nothing about it
 * needs coordinating: a retry writes the same bytes or finds them already
 * there. A board's live state is never here; it is the room's SQLite file.
 */

export interface LoadedSnapshot {
  snapshot: RoomSnapshot;
  meta: SnapshotMeta;
}

/** A stored object exists but cannot be used as a snapshot. */
export class SnapshotUnreadableError extends Error {
  readonly key: string;

  constructor(key: string, reason: string) {
    super(`Stored whiteboard snapshot ${key} is unreadable: ${reason}`);
    this.key = key;
    this.name = "SnapshotUnreadableError";
  }
}

class SnapshotTooLargeError extends Error {
  readonly byteLength: number;

  constructor(byteLength: number) {
    super(`Snapshot is ${byteLength} bytes; the limit is ${WHITEBOARD_CONFIG.MAX_SNAPSHOT_BYTES}`);
    this.byteLength = byteLength;
    this.name = "SnapshotTooLargeError";
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class SnapshotStore {
  private readonly objects: ObjectStore;

  constructor(objects: ObjectStore) {
    this.objects = objects;
  }

  /** The snapshot at `key`, or null when there is no object there. */
  async load(key: string): Promise<LoadedSnapshot | null> {
    const object = await this.objects.get(key);
    return object ? decodeSnapshotObject(key, object) : null;
  }

  /** Store `snapshot` at `key`, or return what an earlier write already put there. */
  async writeAt(key: string, snapshot: RoomSnapshot): Promise<SnapshotMeta> {
    const existing = await this.load(key);
    if (existing) return existing.meta;
    return this.writeNew(key, snapshot);
  }

  private async writeNew(key: string, snapshot: RoomSnapshot): Promise<SnapshotMeta> {
    const text = JSON.stringify(snapshot);
    const body = encoder.encode(text);
    if (body.byteLength > WHITEBOARD_CONFIG.MAX_SNAPSHOT_BYTES) {
      throw new SnapshotTooLargeError(body.byteLength);
    }
    const meta: SnapshotMeta = {
      key,
      hash: await computeWhiteboardSnapshotHash(text),
      documentClock: snapshot.documentClock ?? 0,
      size: body.byteLength,
      assetKeys: extractSnapshotAssetKeys(snapshot),
    };
    const metadata = {
      [SNAPSHOT_METADATA.hash]: meta.hash,
      [SNAPSHOT_METADATA.documentClock]: String(meta.documentClock),
    };
    try {
      await this.objects.put(key, body, metadata, null);
    } catch (error) {
      // A lost reply to a put that landed: the object is the answer.
      const committed = await this.load(key);
      if (committed) return committed.meta;
      throw error;
    }
    return meta;
  }
}

async function decodeSnapshotObject(key: string, object: StoredObject): Promise<LoadedSnapshot> {
  if (object.body.byteLength > WHITEBOARD_CONFIG.MAX_SNAPSHOT_BYTES) {
    throw new SnapshotUnreadableError(key, `${object.body.byteLength} bytes exceeds the limit`);
  }
  const text = decoder.decode(object.body);
  const validation = await validateWhiteboardSnapshotBody(text);
  if (!validation.ok || !validation.hash) {
    throw new SnapshotUnreadableError(key, validation.ok ? "no hash" : validation.error);
  }
  const documentClock =
    validation.snapshot.documentClock
    ?? readSnapshotMetadata(object.metadata).documentClock
    ?? 0;
  return {
    snapshot: validation.snapshot,
    meta: {
      key,
      hash: validation.hash,
      documentClock,
      size: object.body.byteLength,
      assetKeys: extractSnapshotAssetKeys(validation.snapshot),
    },
  };
}
