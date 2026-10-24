import { openSqliteDatabase } from "./sqlite.ts";

export interface WriterLock {
  assertOwned(): void;
  release(): void;
}

/**
 * Hold SQLite's single-writer transaction for the process lifetime.
 *
 * The `BEGIN IMMEDIATE` below *is* the mutual exclusion: it takes SQLite's
 * RESERVED lock on the file, a second process's `BEGIN IMMEDIATE` fails
 * immediately against `busy_timeout = 0`, and the OS drops the lock when this
 * process exits. Unlike the mtime lease this replaced, there is no stale-file
 * recovery and no unfenced takeover window.
 *
 * `writer_owner` is operator-visible provenance (who holds it, since when), not
 * part of the exclusion. Nothing can be learned by reading it back through this
 * same handle — the row is inside our own uncommitted transaction, so it can
 * only ever report ourselves, which is why there is no ownership *poll* here.
 * `assertOwned` asserts the one thing this process can know: that it still
 * holds a usable transaction. Every filesystem-mutating entrypoint calls it, so
 * a handle that has gone bad fails the next write rather than a timer tick.
 */
export function acquireSingleWriterLock(
  dataDir: string,
  options?: { onLost?: () => void },
): WriterLock {
  const lockPath = `${dataDir}/.writer-lock.db`;
  const db = openSqliteDatabase(lockPath);

  let touchOwner: ReturnType<typeof db.prepare> | undefined;
  try {
    db.exec("PRAGMA busy_timeout = 0");
    db.exec("BEGIN IMMEDIATE");
    db.exec(
      "CREATE TABLE IF NOT EXISTS writer_owner (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), pid INTEGER NOT NULL, started_at TEXT NOT NULL)",
    );
    db.prepare(
      "INSERT OR REPLACE INTO writer_owner (singleton, pid, started_at) VALUES (1, ?, ?)",
    ).run(process.pid, new Date().toISOString());
    // Kept prepared for the lifetime of the lock so the liveness probe below
    // never has to compile a statement while the data dir is in doubt.
    touchOwner = db.prepare("UPDATE writer_owner SET pid = ? WHERE singleton = 1");
  } catch (error) {
    try {
      // Closing finalizes every statement prepared on the handle.
      db.close();
    } catch {
      // Preserve the acquisition failure below.
    }
    if (
      error instanceof Error &&
      /locked|busy/i.test(error.message)
    ) {
      throw new Error("Whiteboard data directory is already owned by another writer");
    }
    throw error;
  }

  const probeOwner = touchOwner;
  let released = false;
  let lost = false;

  const assertOwned = () => {
    if (released || lost) {
      throw new Error("Whiteboard writer lock ownership was lost");
    }
    try {
      // A write against the transaction we are holding. It re-dirties a page
      // that acquisition already dirtied, so repeating it is free, and it fails
      // if the handle has been closed or the database has stopped accepting
      // writes — the states in which mutating room files is no longer safe.
      probeOwner.run(process.pid);
    } catch (error) {
      if (!lost) {
        lost = true;
        options?.onLost?.();
      }
      throw new Error("Whiteboard writer lock ownership was lost", { cause: error });
    }
  };

  return {
    assertOwned,
    release: () => {
      if (released) return;
      released = true;
      try {
        if (!lost) db.exec("COMMIT");
      } catch {
        // Closing the handle below still releases the OS-owned SQLite lock.
      }
      db.close();
    },
  };
}
