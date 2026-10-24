import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

// How a table can be reshaped on D1 without losing rows, pinned so a change
// in D1's behaviour shows up here before it shows up in a migration.
//
// Dropping a referenced table cascades into its children (pinned, and enforced
// for every migration, by test/d1-migration-contract.d1.test.ts). This file
// pins the ways around it: D1 ignores `foreign_keys = off` inside a migration,
// a column no table CHECK names can be dropped in place, and a table can be
// rebuilt together with every table that depends on it, leaves dropped first.
// packages/db/REBUILDS.md is the procedure.

const db = () => env.DB;

async function run(statements: string[]) {
  await db().batch(statements.map((sql) => db().prepare(sql)));
}

async function rows(table: string): Promise<number> {
  const row = await db().prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>();
  return row?.n ?? -1;
}

async function definition(table: string): Promise<string> {
  const row = await db().prepare("SELECT sql FROM sqlite_master WHERE name = ?").bind(table).first<{ sql: string }>();
  return row?.sql ?? "";
}

beforeEach(async () => {
  await run([
    "DROP TABLE IF EXISTS rebuild_grandchild",
    "DROP TABLE IF EXISTS rebuild_child",
    "DROP TABLE IF EXISTS rebuild_parent",
    "CREATE TABLE rebuild_parent (id TEXT PRIMARY KEY, kept TEXT, retired TEXT, plain TEXT, CHECK (retired IS NULL OR length(retired) < 10))",
    "CREATE TABLE rebuild_child (id TEXT PRIMARY KEY, parent_id TEXT NOT NULL REFERENCES rebuild_parent(id) ON DELETE CASCADE)",
    "CREATE TABLE rebuild_grandchild (id TEXT PRIMARY KEY, child_id TEXT NOT NULL REFERENCES rebuild_child(id) ON DELETE CASCADE)",
    "CREATE INDEX rebuild_child_parent_idx ON rebuild_child(parent_id)",
    "INSERT INTO rebuild_parent VALUES ('p1', 'a', 'x', 'y'), ('p2', 'b', NULL, NULL)",
    "INSERT INTO rebuild_child VALUES ('c1', 'p1'), ('c2', 'p2')",
    "INSERT INTO rebuild_grandchild VALUES ('g1', 'c1'), ('g2', 'c2')",
  ]);
});

describe("reshaping a referenced table on D1", () => {
  it("ignores foreign_keys = off inside a migration batch", async () => {
    await run([
      "PRAGMA foreign_keys = off",
      "CREATE TABLE rebuild_parent_new (id TEXT PRIMARY KEY, kept TEXT)",
      "INSERT INTO rebuild_parent_new SELECT id, kept FROM rebuild_parent",
      "DROP TABLE rebuild_parent",
      "ALTER TABLE rebuild_parent_new RENAME TO rebuild_parent",
    ]);
    expect(await rows("rebuild_child")).toBe(0);
  });

  it("drops a column no CHECK names, keeping every row", async () => {
    await run(["ALTER TABLE rebuild_parent DROP COLUMN plain"]);
    expect(await rows("rebuild_parent")).toBe(2);
    expect(await rows("rebuild_child")).toBe(2);
  });

  it("refuses to drop a column a table CHECK names", async () => {
    await expect(run(["ALTER TABLE rebuild_parent DROP COLUMN retired"])).rejects.toThrow(/no such column: retired/);
    expect(await rows("rebuild_child")).toBe(2);
  });

  it("keeps every row when the whole dependent subtree is rebuilt, leaves dropped first", async () => {
    await run([
      "PRAGMA defer_foreign_keys = on",
      "CREATE TABLE rebuild_parent_new (id TEXT PRIMARY KEY, kept TEXT)",
      "CREATE TABLE rebuild_child_new (id TEXT PRIMARY KEY, parent_id TEXT NOT NULL REFERENCES rebuild_parent_new(id) ON DELETE CASCADE)",
      "CREATE TABLE rebuild_grandchild_new (id TEXT PRIMARY KEY, child_id TEXT NOT NULL REFERENCES rebuild_child_new(id) ON DELETE CASCADE)",
      "INSERT INTO rebuild_parent_new SELECT id, kept FROM rebuild_parent",
      "INSERT INTO rebuild_child_new SELECT id, parent_id FROM rebuild_child",
      "INSERT INTO rebuild_grandchild_new SELECT id, child_id FROM rebuild_grandchild",
      "DROP TABLE rebuild_grandchild",
      "DROP TABLE rebuild_child",
      "DROP TABLE rebuild_parent",
      "ALTER TABLE rebuild_parent_new RENAME TO rebuild_parent",
      "ALTER TABLE rebuild_child_new RENAME TO rebuild_child",
      "ALTER TABLE rebuild_grandchild_new RENAME TO rebuild_grandchild",
      "CREATE INDEX rebuild_child_parent_idx ON rebuild_child(parent_id)",
    ]);

    expect(await rows("rebuild_parent")).toBe(2);
    expect(await rows("rebuild_child")).toBe(2);
    expect(await rows("rebuild_grandchild")).toBe(2);
    // Renaming a `_new` table rewrites the references other `_new` tables hold.
    expect(await definition("rebuild_child")).toContain('REFERENCES "rebuild_parent"(id)');
    expect(await definition("rebuild_grandchild")).toContain('REFERENCES "rebuild_child"(id)');
    expect((await db().prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);

    // Cascades still run through the rebuilt tables. (Checked last: it changes the rows.)
    await db().prepare("DELETE FROM rebuild_parent WHERE id = 'p1'").run();
    expect(await rows("rebuild_child")).toBe(1);
    expect(await rows("rebuild_grandchild")).toBe(1);
  });

  it("rejects the whole batch when a rebuild leaves an orphan at commit", async () => {
    await expect(run([
      "PRAGMA defer_foreign_keys = on",
      "CREATE TABLE rebuild_parent_new (id TEXT PRIMARY KEY, kept TEXT)",
      "CREATE TABLE rebuild_child_new (id TEXT PRIMARY KEY, parent_id TEXT NOT NULL REFERENCES rebuild_parent_new(id) ON DELETE CASCADE)",
      "CREATE TABLE rebuild_grandchild_new (id TEXT PRIMARY KEY, child_id TEXT NOT NULL REFERENCES rebuild_child_new(id) ON DELETE CASCADE)",
      // A filtered copy: p1's child and grandchild are copied, p1 is not.
      "INSERT INTO rebuild_parent_new SELECT id, kept FROM rebuild_parent WHERE id <> 'p1'",
      "INSERT INTO rebuild_child_new SELECT id, parent_id FROM rebuild_child",
      "INSERT INTO rebuild_grandchild_new SELECT id, child_id FROM rebuild_grandchild",
      "DROP TABLE rebuild_grandchild",
      "DROP TABLE rebuild_child",
      "DROP TABLE rebuild_parent",
      "ALTER TABLE rebuild_parent_new RENAME TO rebuild_parent",
      "ALTER TABLE rebuild_child_new RENAME TO rebuild_child",
      "ALTER TABLE rebuild_grandchild_new RENAME TO rebuild_grandchild",
    ])).rejects.toThrow(/FOREIGN KEY/i);

    // Nothing was applied: the originals are intact.
    expect(await rows("rebuild_parent")).toBe(2);
    expect(await rows("rebuild_child")).toBe(2);
    expect(await definition("rebuild_parent")).toContain("retired");
  });
});
