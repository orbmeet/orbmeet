import { createHash } from "node:crypto";
import { NodeSqliteWrapper, SQLiteSyncStorage } from "@tldraw/sync-core";
import type { TLRecord } from "@tldraw/tlschema";
import { openSqliteDatabase, type SqliteDatabase } from "./sqlite.ts";
import type { SnapshotMeta } from "@orbmeet/whiteboard-core/sync-commands";
import { logError, logWarn } from "../lib/log.ts";

/**
 * Persistence-owned construction of a room's document database.
 *
 * One room database serves two readers over one handle: the `whiteboard_meta`
 * key/value table (board identity, generation, lifecycle, spotlight and
 * navigation) and tldraw's own `SQLiteSyncStorage` document storage. Opening
 * both, deciding whether the initial snapshot seeds an empty database, and
 * closing in the right order are storage mechanics — the Room consumes them and
 * owns none of the SQL.
 *
 * Like every module here, the SQLite driver is reached only through
 * `persistence/sqlite.ts`.
 */

/** The board a room database holds; a room never changes boards. */
export const WHITEBOARD_ID_META_KEY = "whiteboardId";
/** `archived` refuses every write until a reopen; absent means writable. */
export const LIFECYCLE_META_KEY = "lifecycle";
/**
 * The generation this node holds the board at, as D1 numbers it; absent (0)
 * for a database written before boards moved between nodes.
 */
export const GENERATION_META_KEY = "syncGeneration";

/**
 * One restore's outcome, by command id: the stored state it replaced, or null
 * when there was nothing to undo. It holds the restore point's whole
 * description, so a retry answers from this database alone.
 */
export interface RestoreRecord {
  restorePoint: SnapshotMeta | null;
}

const restoreMetaKey = (commandId: string) => `restore:${commandId}`;

export function readRestoreRecord(store: Pick<RoomDocumentStore, "getMeta">, commandId: string): RestoreRecord | null {
  const value = store.getMeta(restoreMetaKey(commandId));
  return value === null ? null : JSON.parse(value) as RestoreRecord;
}

export function writeRestoreRecord(
  store: Pick<RoomDocumentStore, "setMeta">,
  commandId: string,
  record: RestoreRecord,
): void {
  store.setMeta(restoreMetaKey(commandId), JSON.stringify(record));
}

const META_TABLE_DDL =
  "CREATE TABLE IF NOT EXISTS whiteboard_meta (key TEXT PRIMARY KEY, value TEXT)";

export interface RoomDocumentStore {
  /** tldraw document storage over this room's database handle. */
  readonly syncStorage: SQLiteSyncStorage<TLRecord>;
  /** The database held no document before this open, so `initialSnapshot` (or nothing) seeded it. */
  readonly seeded: boolean;
  getMeta(key: string): string | null;
  setMeta(key: string, value: string | null): void;
  close(): void;
}

export function openRoomDocumentStore(dbPath: string, initialSnapshot: unknown): RoomDocumentStore {
  const db = openSqliteDatabase(dbPath);
  // Everything past the open can throw on corrupt or incompatible persisted
  // room state. Guard it so a failure releases the SQLite handle instead of
  // leaking the fd for the process lifetime; the caller only ever sees the
  // original error.
  try {
    // Readers don't block the room's writes, so the nightly backup can copy a
    // board while it is being edited. A reader starting can still hold the
    // WAL index for an instant; the short timeout waits that out rather than
    // failing the write. It is a wait on the event loop every room shares, so
    // it stays far below anything a client would notice.
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA busy_timeout = 100");
    db.exec(META_TABLE_DDL);

    // `query` rather than `prepare`: it returns the statement compiled once for
    // that SQL and kept with the handle, while `prepare` recompiles every call.
    // These run on the hot metadata path — persistSpotlight alone writes six
    // keys per settled viewport — so recompiling would cost a fresh prepare per
    // key per settle, for statements that never vary. Closing the handle
    // releases them, so closing the store needs no extra teardown.
    const getMeta = (key: string): string | null => {
      const row = db.query("SELECT value FROM whiteboard_meta WHERE key = ?").get(key) as
        | { value: string }
        | undefined;
      return row?.value ?? null;
    };
    const setMeta = (key: string, value: string | null): void => {
      if (value === null) {
        db.query("DELETE FROM whiteboard_meta WHERE key = ?").run(key);
      } else {
        db.query("INSERT OR REPLACE INTO whiteboard_meta (key, value) VALUES (?, ?)").run(
          key,
          value,
        );
      }
    };

    const sql = new NodeSqliteWrapper(db);
    const hasStorageData = SQLiteSyncStorage.hasBeenInitialized(sql);
    const syncStorage = new SQLiteSyncStorage<TLRecord>({
      sql,
      snapshot: hasStorageData ? undefined : (initialSnapshot as never),
    });

    return {
      syncStorage,
      seeded: !hasStorageData,
      getMeta,
      setMeta,
      close: () => {
        // Fold the WAL back in, so a closed room's `.db` file alone is the
        // whole board. A reader mid-copy can keep this from finishing; the
        // WAL then stays beside the file, still correct, until the next close.
        try {
          db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        } catch (error) {
          logWarn(`Could not checkpoint ${dbPath} on close:`, error);
        }
        db.close();
      },
    };
  } catch (error) {
    try {
      db.close();
    } catch (closeError) {
      logError(`Failed to close room database after opening failed:`, closeError);
    }
    throw error;
  }
}

/**
 * A value that changes whenever the room's database does: tldraw's document
 * clock (every document change) and the room's own metadata (lifecycle,
 * spotlight, restore records). The backup compares it between runs. File
 * times can't serve: a reader opening an idle room rewrites its WAL files.
 */
export function roomDatabaseFingerprint(db: SqliteDatabase): string {
  const clock = SQLiteSyncStorage.getDocumentClock(new NodeSqliteWrapper(db));
  let meta: unknown[] = [];
  try {
    meta = db.prepare("SELECT key, value FROM whiteboard_meta ORDER BY key").all();
  } catch {
    // A database the room never opened has no metadata table yet.
  }
  return createHash("sha256").update(JSON.stringify([clock, meta])).digest("hex");
}

