/**
 * The single seam between this server and the SQLite driver.
 *
 * This is the only module in the codebase allowed to import `node:sqlite`.
 * Every other module — domain, application, and the rest of persistence —
 * opens databases through `openSqliteDatabase` and handles them as the
 * structural `SqliteDatabase` below, so the driver choice is a one-file
 * concern.
 *
 * `node:sqlite` is the driver tldraw documents for `NodeSqliteWrapper`
 * (docs/tldraw/docs/sync.mdx), so room storage runs on the documented path.
 * The tests run on Node with this same module, so room databases, the writer
 * lock, restore staging and PDF-import recovery execute under test exactly as
 * in production.
 *
 * The interface is deliberately the slice of the driver the server actually
 * uses — not a general-purpose abstraction.
 */

import { DatabaseSync, backup, type StatementSync } from "node:sqlite";

interface SqliteStatement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): unknown;
  iterate(...params: unknown[]): IterableIterator<unknown>;
}

export interface SqliteDatabase {
  exec(sql: string): void;
  /**
   * A consistent copy of the whole database at `path`, made off the event
   * loop: SQLite's online backup, run as a single step on libuv's thread
   * pool, under a read transaction that never blocks a WAL writer. The copy
   * holds what was committed when it began.
   */
  copyTo(path: string): Promise<void>;
  /** A freshly compiled statement. */
  prepare(sql: string): SqliteStatement;
  /**
   * The statement compiled once for this SQL and kept with the handle, for
   * fixed statements on hot paths. Closing the database releases them.
   */
  query(sql: string): SqliteStatement;
  close(): void;
}

/** The largest page count one backup step takes: every page there is. */
const WHOLE_DATABASE_PAGES = 2 ** 31 - 1;

export interface SqliteOpenOptions {
  readonly?: boolean;
}

export function openSqliteDatabase(filename: string, options?: SqliteOpenOptions): SqliteDatabase {
  // Read-write handles create a missing file; read-only ones refuse it.
  const db = new DatabaseSync(filename, { readOnly: options?.readonly ?? false });
  const cached = new Map<string, StatementSync>();
  return {
    exec: (sql) => db.exec(sql),
    copyTo: async (path) => {
      // One step, not the default batches of 100 pages: a write by another
      // connection between steps restarts the backup, and a busy room writes
      // often enough to keep restarting it.
      await backup(db, path, { rate: WHOLE_DATABASE_PAGES });
    },
    prepare: (sql) => db.prepare(sql),
    query: (sql) => {
      let statement = cached.get(sql);
      if (!statement) {
        statement = db.prepare(sql);
        cached.set(sql, statement);
      }
      return statement;
    },
    close: () => {
      cached.clear();
      db.close();
    },
  };
}
