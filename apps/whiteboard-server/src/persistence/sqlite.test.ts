import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openSqliteDatabase } from "./sqlite.ts";

// These run on the runtime the server ships on (Node), so a change in its node:sqlite surface or semantics the server relies
// on fails here rather than in production.

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "orbmeet-sqlite-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("node:sqlite driver surface", () => {
  it("satisfies the SqliteDatabase seam the server codes against", () => {
    const db = openSqliteDatabase(":memory:");
    try {
      db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL, bytes BLOB)");

      const insert = db.prepare("INSERT INTO t (id, name, bytes) VALUES (?, ?, ?)");
      insert.run(1, "one", new Uint8Array([1, 2]));
      insert.run(2, "two", null);

      expect({ ...db.query("SELECT name FROM t WHERE id = ?").get(1) as object }).toEqual({ name: "one" });
      expect(db.query("SELECT name FROM t ORDER BY id").all().map((row) => ({ ...row as object }))).toEqual([
        { name: "one" },
        { name: "two" },
      ]);
      expect([...db.query("SELECT id FROM t ORDER BY id").iterate()].map((row) => ({ ...row as object }))).toEqual([
        { id: 1 },
        { id: 2 },
      ]);
      expect((db.query("SELECT bytes FROM t WHERE id = 1").get() as { bytes: Uint8Array }).bytes)
        .toEqual(new Uint8Array([1, 2]));
    } finally {
      db.close();
    }
  });

  it("caches statements on query() and recompiles on prepare()", () => {
    const db = openSqliteDatabase(":memory:");
    try {
      // Room's meta accessors depend on this split: query() is the hot path's
      // cache read, prepare() compiles afresh.
      expect(db.query("SELECT 1 AS n")).toBe(db.query("SELECT 1 AS n"));
      expect(db.prepare("SELECT 1 AS n")).not.toBe(db.prepare("SELECT 1 AS n"));
    } finally {
      db.close();
    }
  });

  it("closes with statements still prepared", () => {
    const db = openSqliteDatabase(":memory:");
    db.query("SELECT 1");
    db.prepare("SELECT 2");
    expect(() => db.close()).not.toThrow();
  });
});

describe("openSqliteDatabase options", () => {
  it("creates a missing file read-write", () => {
    const path = join(makeTempDir(), "created.db");
    const db = openSqliteDatabase(path);
    try {
      db.exec("CREATE TABLE t (v)");
    } finally {
      db.close();
    }
    expect(existsSync(path)).toBe(true);
  });

  it("readonly refuses writes, and a missing file", () => {
    const path = join(makeTempDir(), "options.db");
    expect(() => openSqliteDatabase(path, { readonly: true })).toThrow();
    const writer = openSqliteDatabase(path);
    writer.exec("CREATE TABLE t (v)");
    writer.close();
    const db = openSqliteDatabase(path, { readonly: true });
    try {
      expect(() => db.exec("INSERT INTO t VALUES (1)")).toThrow();
    } finally {
      db.close();
    }
  });

  it("copies a WAL database off the event loop while its writer keeps writing", async () => {
    const dir = makeTempDir();
    const path = join(dir, "room.db");
    const writer = openSqliteDatabase(path);
    writer.exec("PRAGMA journal_mode = WAL; CREATE TABLE t (bytes BLOB)");
    const insert = writer.prepare("INSERT INTO t VALUES (randomblob(4000))");
    for (let row = 0; row < 2_000; row++) insert.run();

    const reader = openSqliteDatabase(path, { readonly: true });
    let turns = 0;
    const ticking = setInterval(() => {
      turns += 1;
      insert.run();
    }, 0);
    try {
      await reader.copyTo(join(dir, "copy.db"));
    } finally {
      clearInterval(ticking);
      reader.close();
      writer.close();
    }

    const copy = openSqliteDatabase(join(dir, "copy.db"), { readonly: true });
    try {
      expect(copy.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      expect((copy.prepare("SELECT count(*) AS n FROM t").get() as { n: number }).n).toBeGreaterThanOrEqual(2_000);
    } finally {
      copy.close();
    }
    expect(turns).toBeGreaterThan(0);
  });
});
