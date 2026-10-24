import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";
import {
  generationOfRoomCopyKey,
  whiteboardRoomCopiesPrefix,
  whiteboardRoomCopyKey,
} from "@orbmeet/whiteboard-core/document-keys";
import type { ObjectStore } from "./r2.ts";
import { GENERATION_META_KEY, roomDatabaseFingerprint } from "./room-document-store.ts";
import { removeRoomFiles } from "./room-storage.ts";
import { openSqliteDatabase } from "./sqlite.ts";

/**
 * Saved copies of the room databases: what lets any node take a board over.
 *
 * A board lives on one node at a time, the one D1 names, and its room
 * database there is the working copy. The node saves it to R2 as it changes
 * (each minute while it changes, and when its room closes or the board moves
 * on), so losing a node costs at most the last minute of a board in use, and
 * nothing of one at rest.
 *
 * A copy is taken with SQLite's online backup (`SqliteDatabase.copyTo`), a
 * consistent snapshot made off the event loop while the server keeps writing
 * (room databases are in WAL mode, so the copy never blocks a write),
 * gzipped, and stored under the generation the node holds the board at
 * (`whiteboardRoomCopyKey`). Each generation writes only its own
 * key, so a node the board has moved on from cannot overwrite a newer copy.
 * Once a generation's copy is saved, older generations' copies are deleted.
 */

const ROOM_FILE = /^(meet-[A-Za-z0-9_-]+)\.db$/;
/** One file per room, holding its fingerprint as of its last saved copy. */
const MARKER_DIR = ".copy-state";
/** The single marker file every room once shared; see `removeLegacyCopyMarker`. */
const LEGACY_MARKER_FILE = ".copy-state.json";
const STAGING_DIR = ".copy-staging";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

/** The rooms with a database in `dataDir`. */
export function roomIds(dataDir: string): string[] {
  return readdirSync(dataDir).flatMap((name) => ROOM_FILE.exec(name)?.[1] ?? []).sort();
}

/** The room's fingerprint as of its last saved copy, or null when it has none. */
function readMarker(dataDir: string, whiteboardRoomId: string): string | null {
  try {
    return readFileSync(join(dataDir, MARKER_DIR, whiteboardRoomId), "utf8");
  } catch {
    return null;
  }
}

function writeMarker(dataDir: string, whiteboardRoomId: string, fingerprint: string): void {
  const dir = join(dataDir, MARKER_DIR);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, whiteboardRoomId);
  writeFileSync(`${path}.new`, fingerprint);
  renameSync(`${path}.new`, path);
}

/**
 * Drop the marker file every room shared before each got its own. Without it
 * each room is saved once more on its next change check, which is harmless.
 */
export function removeLegacyCopyMarker(dataDir: string): void {
  rmSync(join(dataDir, LEGACY_MARKER_FILE), { force: true });
}

/**
 * Read-only: a read-write connection, even one that only reads, blocks the
 * server's writes for a moment, and the server cannot wait for a lock. A room
 * without its WAL index (one nobody has opened since it was loaded) has no
 * writer to block, so read-write is safe there.
 */
function openForCopy(path: string) {
  try {
    return openSqliteDatabase(path, { readonly: true });
  } catch {
    return openSqliteDatabase(path);
  }
}

function readGeneration(db: ReturnType<typeof openSqliteDatabase>): number {
  try {
    const row = db.prepare("SELECT value FROM whiteboard_meta WHERE key = ?").get(GENERATION_META_KEY) as
      | { value?: unknown }
      | undefined;
    const generation = Number(row?.value);
    return Number.isSafeInteger(generation) && generation >= 0 ? generation : 0;
  } catch {
    // A database the room never opened has no metadata table yet.
    return 0;
  }
}

/**
 * The generation a room database on disk holds its board at: 0 for one
 * written before boards moved, null when there is no database.
 */
export function roomGenerationOnDisk(dataDir: string, whiteboardRoomId: string): number | null {
  const path = join(dataDir, `${whiteboardRoomId}.db`);
  if (!existsSync(path)) return null;
  const db = openForCopy(path);
  try {
    return readGeneration(db);
  } finally {
    db.close();
  }
}

/** Record that the database on disk now holds its board at `generation`. The room must be closed. */
export function writeGenerationOnDisk(dataDir: string, whiteboardRoomId: string, generation: number): void {
  const db = openSqliteDatabase(join(dataDir, `${whiteboardRoomId}.db`));
  try {
    db.exec("CREATE TABLE IF NOT EXISTS whiteboard_meta (key TEXT PRIMARY KEY, value TEXT)");
    db.prepare("INSERT OR REPLACE INTO whiteboard_meta (key, value) VALUES (?, ?)")
      .run(GENERATION_META_KEY, String(generation));
  } finally {
    db.close();
  }
}

/** The newest saved copy at or below `generation`, if any. */
export async function newestRoomCopy(
  objects: ObjectStore,
  whiteboardRoomId: string,
  generation: number,
): Promise<{ key: string; generation: number } | null> {
  let newest: { key: string; generation: number } | null = null;
  for (const key of await objects.list(whiteboardRoomCopiesPrefix(whiteboardRoomId))) {
    const saved = generationOfRoomCopyKey(whiteboardRoomId, key);
    if (saved !== null && saved <= generation && (!newest || saved > newest.generation)) {
      newest = { key, generation: saved };
    }
  }
  return newest;
}

/**
 * Replace the room's database with a saved copy. The room must be closed.
 * Every file of the old database goes first: SQLite would replay a stale
 * `-wal` left beside the new one into it.
 */
export async function loadRoomCopy(options: {
  dataDir: string;
  objects: ObjectStore;
  whiteboardRoomId: string;
  key: string;
}): Promise<void> {
  const { dataDir, objects, whiteboardRoomId, key } = options;
  const object = await objects.get(key);
  if (!object) throw new Error(`Room copy ${key} is gone`);
  const body = await gunzipAsync(object.body);
  const staging = join(dataDir, STAGING_DIR);
  mkdirSync(staging, { recursive: true });
  const staged = join(staging, `${whiteboardRoomId}.db`);
  await writeFile(staged, body);
  removeRoomFiles(dataDir, whiteboardRoomId);
  renameSync(staged, join(dataDir, `${whiteboardRoomId}.db`));
  // What was just loaded is what R2 holds: no need to save it straight back.
  const db = openForCopy(join(dataDir, `${whiteboardRoomId}.db`));
  try {
    writeMarker(dataDir, whiteboardRoomId, roomDatabaseFingerprint(db));
  } finally {
    db.close();
  }
}

/**
 * Save the room's database to R2 when it changed since its last saved copy.
 * Returns the generation it is saved at, or null when there is no database.
 * Throws when the copy could not be saved, leaving the room to be tried again.
 */
export async function saveRoomCopy(options: {
  dataDir: string;
  objects: ObjectStore;
  whiteboardRoomId: string;
}): Promise<number | null> {
  const { dataDir, objects, whiteboardRoomId } = options;
  const path = join(dataDir, `${whiteboardRoomId}.db`);
  if (!existsSync(path)) return null;
  const staging = join(dataDir, STAGING_DIR);
  mkdirSync(staging, { recursive: true });
  const copy = join(staging, `${whiteboardRoomId}.save.db`);
  let generation: number;
  let fingerprint: string;
  try {
    const db = openForCopy(path);
    try {
      // Read before copying: a write landing in between is in the copy but
      // not the fingerprint, so the next save copies it again rather than
      // missing it.
      fingerprint = roomDatabaseFingerprint(db);
      generation = readGeneration(db);
      if (readMarker(dataDir, whiteboardRoomId) === fingerprint) return generation;
      await db.copyTo(copy);
    } finally {
      db.close();
    }
    const body = new Uint8Array(await gzipAsync(await readFile(copy)));
    await objects.put(whiteboardRoomCopyKey(whiteboardRoomId, generation), body, {});
  } finally {
    rmSync(copy, { force: true });
  }
  writeMarker(dataDir, whiteboardRoomId, fingerprint);
  // Older generations are superseded by the copy just saved.
  for (const key of await objects.list(whiteboardRoomCopiesPrefix(whiteboardRoomId))) {
    const saved = generationOfRoomCopyKey(whiteboardRoomId, key);
    if (saved !== null && saved < generation) await objects.delete(key);
  }
  return generation;
}

/** Forget a room this node no longer holds: its next copy here starts from R2. */
export function forgetRoomCopy(dataDir: string, whiteboardRoomId: string): void {
  rmSync(join(dataDir, MARKER_DIR, whiteboardRoomId), { force: true });
}

/** Delete every saved copy of a board that is gone. */
export async function deleteRoomCopies(objects: ObjectStore, whiteboardRoomId: string): Promise<void> {
  for (const key of await objects.list(whiteboardRoomCopiesPrefix(whiteboardRoomId))) await objects.delete(key);
}
