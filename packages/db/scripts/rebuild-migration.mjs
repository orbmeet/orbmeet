// D1-safe table rebuilds (see ../REBUILDS.md).
//
//   pnpm rebuild-migration generate
//     Rewrites the newest migration, as drizzle-kit generated it, into a
//     subtree rebuild: every reshaped table and every table that depends on
//     it is created as `<name>_new`, copied parents first, dropped leaves
//     first, renamed, and given back its indexes and triggers. Run it right
//     after `pnpm generate`, then add any notes the migration needs at the top.
//
//   pnpm rebuild-migration dry-run <database.sqlite> <appliedCount>
//     Applies the migrations after the first <appliedCount> to a copy of
//     <database.sqlite>, as D1 does (foreign keys on, one transaction per
//     migration), and checks that every row of every kept column survived
//     unchanged and that no foreign key is violated. The file is not modified.
//     `appliedCount` is how many migrations that database has already run.
//
// Run from packages/db; pass an absolute path to the database. Requires
// Node 22.5+ (node:sqlite).
import { DatabaseSync } from "node:sqlite";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DATABASE_TRIGGERS } from "../src/triggers.ts";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "drizzle", "migrations");
const BREAKPOINT = "--> statement-breakpoint";
const INTERNAL_TABLES = "name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations'";

const folders = readdirSync(MIGRATIONS_DIR).filter((name) => /^\d+_/.test(name)).sort();
const migrationFile = (folder) => join(MIGRATIONS_DIR, folder, "migration.sql");
const splitStatements = (sql) => sql
  .split(BREAKPOINT)
  .map((statement) => statement.trim())
  // A statement of comments alone is empty SQL.
  .filter((statement) => statement.replace(/^(?:\s*--[^\n]*\n?)*/u, "").trim());
const statementsOf = (folder) => splitStatements(readFileSync(migrationFile(folder), "utf8"));

function build(count, { dropTriggersBeforeLast = false } = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const [index, folder] of folders.slice(0, count).entries()) {
    if (dropTriggersBeforeLast && index === count - 1) {
      const triggers = db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND ${INTERNAL_TABLES}`)
        .all();
      for (const { name } of triggers) db.exec(`DROP TRIGGER \`${String(name)}\``);
    }
    for (const statement of statementsOf(folder)) db.exec(statement);
  }
  return db;
}

/**
 * drizzle-kit writes a text primary key without NOT NULL, and SQLite then
 * allows a NULL key (only INTEGER PRIMARY KEY implies NOT NULL).
 */
const withNotNullTextPrimaryKeys = (sql) =>
  sql.replace(/(`\w+` text PRIMARY KEY)(?! NOT NULL)/g, "$1 NOT NULL");

// ─── generate ──────────────────────────────────────────────────────────────

function generate() {
  const generated = folders.at(-1);
  const oldDb = build(folders.length - 1);
  const targetDb = build(folders.length, { dropTriggersBeforeLast: true });

  const IDENT = String.raw`[\`"]?(\w+)[\`"]?`;
  const objects = (db, type) => db
    .prepare(`SELECT name, tbl_name AS tableName, sql FROM sqlite_master WHERE type = ? AND sql IS NOT NULL AND ${INTERNAL_TABLES} ORDER BY name`)
    .all(type);
  const columns = (db, table) => db.prepare(`PRAGMA table_info("${table}")`).all().map((row) => row.name);
  const foreignKeys = (db, table) => {
    const groups = new Map();
    for (const row of db.prepare(`PRAGMA foreign_key_list("${table}")`).all()) {
      const group = groups.get(row.id) ?? { table: row.table, from: [], to: [] };
      group.from[row.seq] = row.from;
      group.to[row.seq] = row.to;
      groups.set(row.id, group);
    }
    return [...groups.values()];
  };
  const parents = (db, table) => [...new Set(foreignKeys(db, table).map((fk) => fk.table))];
  const primaryKey = (db, table) => db.prepare(`PRAGMA table_info("${table}")`).all()
    .filter((row) => row.pk > 0).sort((a, b) => a.pk - b.pk).map((row) => row.name);
  const indexColumns = (db, index) => db.prepare(`PRAGMA index_info("${index}")`).all().map((row) => row.name).join(",");

  const oldTables = new Map(objects(oldDb, "table").map((row) => [row.name, row]));
  const targetTables = new Map(objects(targetDb, "table").map((row) => [row.name, row]));
  const newTables = [...targetTables.keys()].filter((name) => !oldTables.has(name));
  const droppedTables = [...oldTables.keys()].filter((name) => !targetTables.has(name));

  // Tables that drizzle-kit altered with a plain `ALTER TABLE ... DROP COLUMN`
  // (no table rebuild needed) stay out of the subtree rebuild.
  const rawStatements = statementsOf(generated);
  const plainDropColumns = [];
  const plainAlteredTables = new Set();
  for (const statement of rawStatements) {
    const match = new RegExp(String.raw`^ALTER\s+TABLE\s+${IDENT}\s+DROP\s+COLUMN\s+${IDENT}`, "i").exec(statement);
    if (match) {
      plainDropColumns.push({ table: match[1], statement });
      plainAlteredTables.add(match[1]);
    }
  }
  for (const statement of rawStatements) {
    const match = new RegExp(String.raw`^CREATE\s+TABLE\s+[\`"]?__new_(\w+)[\`"]?`, "i").exec(statement);
    if (match) plainAlteredTables.delete(match[1]);
  }

  // Tables whose shape changed (beyond plain column drops), and every table that depends on one.
  const body = (sql) => sql.replace(/^CREATE TABLE \S+/, "").replace(/["`]/g, "").replace(/\s+/g, " ").trim();
  const reshaped = [...targetTables.keys()]
    .filter((name) =>
      oldTables.has(name)
      && !plainAlteredTables.has(name)
      && body(oldTables.get(name).sql) !== body(targetTables.get(name).sql),
    );
  if (reshaped.length === 0) throw new Error(`${generated} reshapes no existing table: nothing to rebuild`);
  const subtree = new Set(reshaped);
  for (let grew = true; grew;) {
    grew = false;
    for (const name of targetTables.keys()) {
      if (subtree.has(name) || !oldTables.has(name)) continue;
      if (parents(targetDb, name).some((parent) => subtree.has(parent))) {
        subtree.add(name);
        grew = true;
      }
    }
  }

  // Order dropped tables leaves-first so dropping them cannot cascade into another dropped table.
  const droppedOrder = [];
  const droppedState = new Map();
  const droppedSet = new Set(droppedTables);
  const visitDropped = (name) => {
    if (droppedState.get(name) === "done") return;
    droppedState.set(name, "active");
    for (const parent of parents(oldDb, name)) if (parent !== name && droppedSet.has(parent)) visitDropped(parent);
    droppedState.set(name, "done");
    droppedOrder.push(name);
  };
  for (const name of [...droppedTables].sort()) visitDropped(name);
  droppedOrder.reverse();

  // Parents before children. A cycle across tables would need deferred checks.
  const order = [];
  const state = new Map();
  const visit = (name, path = []) => {
    if (state.get(name) === "done") return;
    if (state.get(name) === "active") throw new Error(`Foreign-key cycle: ${[...path, name].join(" -> ")}`);
    state.set(name, "active");
    for (const parent of parents(targetDb, name)) if (parent !== name && subtree.has(parent)) visit(parent, [...path, name]);
    state.set(name, "done");
    order.push(name);
  };
  for (const name of [...subtree].sort()) visit(name);
  const selfReferencing = order.filter((name) => parents(targetDb, name).includes(name));

  const asNew = (sql) => withNotNullTextPrimaryKeys(sql)
    .replace(new RegExp(String.raw`^CREATE TABLE ${IDENT}`), (_, name) => `CREATE TABLE \`${name}_new\``)
    .replace(new RegExp(String.raw`REFERENCES ${IDENT}`, "g"), (clause, name) =>
      subtree.has(name) ? `REFERENCES \`${name}_new\`` : clause);

  const targetIndexes = objects(targetDb, "index");
  const oldTriggers = objects(oldDb, "trigger");

  // A foreign key to columns other than the parent's primary key needs a
  // unique index on them before any child row is copied. The original table
  // still holds the index's name, so it is created under a temporary name and
  // dropped once the real one is back.
  const keyIndexes = [];
  for (const name of order) {
    for (const fk of foreignKeys(targetDb, name)) {
      if (!subtree.has(fk.table) || fk.to.join(",") === primaryKey(targetDb, fk.table).join(",")) continue;
      const index = targetIndexes.find((candidate) => candidate.tableName === fk.table
        && /^CREATE UNIQUE INDEX/i.test(candidate.sql) && indexColumns(targetDb, candidate.name) === fk.to.join(","));
      if (!index) throw new Error(`No unique index on ${fk.table}(${fk.to}) for ${name}`);
      if (!keyIndexes.includes(index)) keyIndexes.push(index);
    }
  }

  // Triggers on tables outside `subtree` whose body references a table being
  // dropped/renamed must be dropped beforehand (SQLite validates all triggers
  // during `ALTER TABLE ... RENAME TO`) and recreated once the tables are back.
  const externalTriggers = oldTriggers.filter((trigger) =>
    !subtree.has(trigger.tableName)
    && [...subtree].some((name) => new RegExp(String.raw`\b${name}\b`, "i").test(trigger.sql)),
  );

  const statements = [];
  for (const trigger of externalTriggers) statements.push(`DROP TRIGGER \`${trigger.name}\``);
  for (const name of droppedOrder) statements.push(`DROP TABLE \`${name}\``);
  for (const name of order) statements.push(asNew(targetTables.get(name).sql));
  for (const index of keyIndexes) {
    statements.push(index.sql
      .replace(new RegExp(String.raw`INDEX ${IDENT}`), (_, name) => `INDEX \`${name}_rebuild\``)
      .replace(new RegExp(String.raw` ON ${IDENT}`), (_, name) => ` ON \`${name}_new\``));
  }
  for (const name of order) {
    const kept = columns(targetDb, name).filter((column) => columns(oldDb, name).includes(column));
    const list = kept.map((column) => `\`${column}\``).join(", ");
    const parentsFirst = selfReferencing.includes(name) ? " ORDER BY rowid" : "";
    statements.push(`INSERT INTO \`${name}_new\` (${list}) SELECT ${list} FROM \`${name}\`${parentsFirst}`);
  }
  for (const name of [...order].reverse()) statements.push(`DROP TABLE \`${name}\``);
  for (const name of order) statements.push(`ALTER TABLE \`${name}_new\` RENAME TO \`${name}\``);
  for (const index of targetIndexes) if (subtree.has(index.tableName)) statements.push(index.sql);
  const declaredTriggers = DATABASE_TRIGGERS;
  for (const trigger of oldTriggers) {
    const allowed = declaredTriggers[trigger.tableName] ?? [];
    if ((subtree.has(trigger.tableName) || externalTriggers.includes(trigger)) && allowed.includes(trigger.name)) {
      statements.push(trigger.sql);
    }
  }
  for (const name of newTables) {
    statements.push(withNotNullTextPrimaryKeys(targetTables.get(name).sql));
    for (const index of targetIndexes) if (index.tableName === name) statements.push(index.sql);
  }
  for (const { table, statement } of plainDropColumns) {
    // A table the subtree pulled in as a dependent is rebuilt from the target
    // schema, already without the column: dropping it again would fail.
    if (plainAlteredTables.has(table) && !subtree.has(table)) statements.push(statement.replace(/;+$/, ""));
  }
  for (const index of keyIndexes) statements.push(`DROP INDEX \`${index.name}_rebuild\``);
  statements.push("PRAGMA optimize");

  // The header rides on the first statement: a comment-only statement is empty SQL.
  const header = `-- Generated by packages/db/scripts/rebuild-migration.mjs from the schemas
-- before and after this migration; see packages/db/REBUILDS.md. Rebuilds
-- ${reshaped.join(", ")} with every table that depends on them (${order.length} tables):
-- create each as \`<name>_new\`, copy parents first, drop the originals leaves
-- first, rename, then recreate their indexes and triggers.`;
  statements[0] = `${header}\n${statements[0]}`;
  writeFileSync(migrationFile(generated), statements.map((statement) => `${statement};`).join(`${BREAKPOINT}\n`) + "\n");

  console.log(JSON.stringify({
    rewrote: generated,
    reshaped,
    rebuilt: order.length,
    selfReferencing,
    temporaryKeyIndexes: keyIndexes.length,
    newTables,
  }, null, 1));
}

// ─── dry-run ───────────────────────────────────────────────────────────────

function dryRun(databaseFile, appliedCount) {
  const applied = Number(appliedCount);
  if (!databaseFile || !Number.isInteger(applied) || applied < 0 || applied > folders.length) {
    throw new Error(`Usage: dry-run <database.sqlite> <appliedCount 0..${folders.length}>`);
  }
  const pending = folders.slice(applied);
  if (pending.length === 0) throw new Error("No pending migration to dry-run");

  const workDir = mkdtempSync(join(tmpdir(), "rebuild-dry-run-"));
  try {
    const before = join(workDir, "before.sqlite");
    const after = join(workDir, "after.sqlite");
    copyFileSync(databaseFile, before);
    copyFileSync(databaseFile, after);

    const db = new DatabaseSync(after);
    db.exec("PRAGMA foreign_keys = ON");
    const started = performance.now();
    for (const folder of pending) {
      db.exec("BEGIN");
      try {
        for (const statement of statementsOf(folder)) db.exec(statement);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw new Error(`${folder} failed: ${error.message}`);
      }
    }
    const elapsedMs = Math.round(performance.now() - started);

    // Every table present before must hold the same rows in every column it kept.
    db.exec(`ATTACH DATABASE '${before.replaceAll("'", "''")}' AS before`);
    const tablesIn = (schema) => db.prepare(`SELECT name FROM ${schema}.sqlite_master WHERE type = 'table' AND ${INTERNAL_TABLES} ORDER BY name`)
      .all().map((row) => String(row.name));
    const columnsIn = (schema, table) => db.prepare(`PRAGMA ${schema}.table_info("${table}")`).all().map((row) => String(row.name));
    const countOf = (sql) => Number(db.prepare(sql).get().n);
    const afterTables = new Set(tablesIn("main"));
    const differing = [];
    const droppedTables = [];
    let rows = 0;
    for (const table of tablesIn("before")) {
      if (!afterTables.has(table)) {
        droppedTables.push(table);
        continue;
      }
      const kept = columnsIn("main", table).filter((column) => columnsIn("before", table).includes(column));
      const list = kept.map((column) => `"${column}"`).join(", ");
      const missing = countOf(`SELECT count(*) AS n FROM (SELECT ${list} FROM before."${table}" EXCEPT SELECT ${list} FROM main."${table}")`);
      const extra = countOf(`SELECT count(*) AS n FROM (SELECT ${list} FROM main."${table}" EXCEPT SELECT ${list} FROM before."${table}")`);
      const countBefore = countOf(`SELECT count(*) AS n FROM before."${table}"`);
      const countAfter = countOf(`SELECT count(*) AS n FROM main."${table}"`);
      if (missing || extra || countBefore !== countAfter) differing.push({ table, countBefore, countAfter, missing, extra });
      rows += countAfter;
    }
    const foreignKeyViolations = db.prepare("PRAGMA foreign_key_check").all().length;
    db.close();

    const ok = differing.length === 0 && foreignKeyViolations === 0;
    console.log(JSON.stringify({
      ok,
      applied: pending,
      elapsedMs,
      rowsCompared: rows,
      differing,
      droppedTables,
      foreignKeyViolations,
    }, null, 1));
    if (!ok) process.exitCode = 1;
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

const [command, ...args] = process.argv.slice(2);
if (command === "generate") generate();
else if (command === "dry-run") dryRun(...args);
else {
  console.error("Usage: rebuild-migration.mjs generate | dry-run <database.sqlite> <appliedCount>");
  process.exitCode = 2;
}
