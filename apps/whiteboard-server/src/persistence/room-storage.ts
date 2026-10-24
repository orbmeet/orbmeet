import { existsSync, mkdirSync, unlinkSync } from "node:fs";

/**
 * A room's SQLite file is its board's working copy on the node holding it.
 * These helpers name and remove the files; `room-document-store.ts` opens
 * them, and `room-copies.ts` saves them to R2 and loads them back.
 *
 * A file that cannot be opened is left exactly where it is. Moving it aside
 * would let the next open create an empty board in its place; its last saved
 * copy is what recovers it.
 */

function roomDatabasePath(dataDir: string, whiteboardRoomId: string): string {
  return `${dataDir}/${whiteboardRoomId}.db`;
}

export function roomDatabaseExists(dataDir: string, whiteboardRoomId: string): boolean {
  return existsSync(roomDatabasePath(dataDir, whiteboardRoomId));
}

export function ensureRoomDataDir(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true });
}

/** Delete a room's database and its WAL sidecars. The room must be closed. */
export function removeRoomFiles(dataDir: string, whiteboardRoomId: string): void {
  const basePath = roomDatabasePath(dataDir, whiteboardRoomId);
  for (const path of [basePath, `${basePath}-wal`, `${basePath}-shm`]) {
    try {
      unlinkSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
