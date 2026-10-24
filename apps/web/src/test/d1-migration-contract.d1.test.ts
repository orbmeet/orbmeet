import type { D1Migration } from "@cloudflare/vitest-plugin";
import { env } from "cloudflare:workers";
import { DATABASE_TRIGGERS } from "@orbmeet/db/triggers";
import { describe, expect, it } from "vitest";

type D1TestEnv = Env & {
  TEST_MIGRATIONS: D1Migration[];
  TEST_SCHEMA_SNAPSHOT: { ddl: SnapshotItem[] };
};

type SnapshotItem = {
  columns?: string[];
  columnsTo?: string[];
  entityType: string;
  name: string;
  notNull?: boolean;
  onDelete?: string;
  onUpdate?: string;
  table?: string;
  tableTo?: string;
  value?: string;
};

type ForeignKeyRow = {
  from: string;
  id: number;
  on_delete: string;
  on_update: string;
  seq: number;
  table: string;
  to: string;
};

type TableInfoRow = {
  name: string;
  notnull: number;
  pk: number;
  type: string;
};

const testEnv = env as D1TestEnv;
const latestSnapshot = testEnv.TEST_SCHEMA_SNAPSHOT;

function quoteIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`Unsafe SQLite identifier: ${value}`);
  }
  return `"${value}"`;
}

function normalizeSql(value: string): string {
  return value
    .replace(/["`]/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}

function foreignKeyShape(input: {
  columns: string[];
  columnsTo: string[];
  onDelete: string;
  onUpdate: string;
  table: string;
  tableTo: string;
}): string {
  return [
    input.table,
    input.columns.join(","),
    input.tableTo,
    input.columnsTo.join(","),
    input.onDelete,
    input.onUpdate,
  ].join("|");
}

const IDENTIFIER = '[`"]?(\\w+)[`"]?';
const CREATE_TABLE = new RegExp(String.raw`^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?${IDENTIFIER}`, "iu");
const DROP_TABLE = new RegExp(String.raw`^\s*DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?${IDENTIFIER}`, "iu");
const RENAME_TABLE = new RegExp(String.raw`^\s*ALTER\s+TABLE\s+${IDENTIFIER}\s+RENAME\s+TO\s+${IDENTIFIER}`, "iu");
const ADD_COLUMN = new RegExp(String.raw`^\s*ALTER\s+TABLE\s+${IDENTIFIER}\s+ADD\b`, "iu");
const REFERENCES = new RegExp(String.raw`\bREFERENCES\s+${IDENTIFIER}`, "giu");

function referencedTables(sql: string): Set<string> {
  return new Set([...sql.matchAll(REFERENCES)].map((match) => match[1]));
}

/**
 * Replay migrations' DDL and report every `DROP TABLE` of a table another
 * table still references.
 *
 * D1 always enforces foreign keys, and SQLite drops a table by first deleting
 * its rows. That delete runs the referencing tables' actions: ON DELETE CASCADE
 * rows go with it, SET NULL rows lose their link, and RESTRICT fails the
 * migration. `defer_foreign_keys` defers checks, not actions. Rebuilding a
 * referenced table the way drizzle-kit does (create `__new_x`, copy, drop `x`,
 * rename) therefore destroys its children; such a change needs a migration
 * that rebuilds the children too, dropping them first.
 */
function dropsOfReferencedTables(migrations: readonly { name: string; queries: string[] }[]): string[] {
  const tables = new Map<string, string>();
  const violations: string[] = [];
  for (const migration of migrations) {
    for (const query of migration.queries) {
      const statement = query.replace(/^(?:\s*--[^\n]*\n)*/u, "");
      const created = CREATE_TABLE.exec(statement);
      if (created) {
        tables.set(created[1], statement);
        continue;
      }
      const dropped = DROP_TABLE.exec(statement);
      if (dropped) {
        const table = dropped[1];
        const referrers = [...tables]
          .filter(([name, sql]) => name !== table && referencedTables(sql).has(table))
          .map(([name]) => name)
          .sort();
        if (referrers.length > 0) {
          violations.push(`${migration.name}: drops ${table}, which ${referrers.join(", ")} reference`);
        }
        tables.delete(table);
        continue;
      }
      const renamed = RENAME_TABLE.exec(statement);
      if (renamed) {
        const [, from, to] = renamed as unknown as [string, string, string];
        const sql = tables.get(from);
        tables.delete(from);
        if (sql !== undefined) tables.set(to, sql);
        // SQLite points other tables' foreign keys at the new name.
        for (const [name, other] of tables) {
          tables.set(name, other.replace(REFERENCES, (clause, target: string) =>
            target === from ? clause.replace(target, to) : clause));
        }
        continue;
      }
      const altered = ADD_COLUMN.exec(statement)?.[1];
      const sql = altered === undefined ? undefined : tables.get(altered);
      if (altered !== undefined && sql !== undefined) tables.set(altered, `${sql}\n${statement}`);
    }
  }
  return violations;
}

describe("dropsOfReferencedTables", () => {
  const migration = (name: string, ...queries: string[]) => ({ name, queries });
  const parentAndChild = migration(
    "0001",
    "CREATE TABLE `parent` (`id` text PRIMARY KEY NOT NULL)",
    "CREATE TABLE `child` (`id` text PRIMARY KEY NOT NULL, `parent_id` text REFERENCES `parent`(`id`) ON DELETE CASCADE)",
  );

  it("reports a rebuild of a referenced table", () => {
    expect(dropsOfReferencedTables([
      parentAndChild,
      migration(
        "0002",
        "CREATE TABLE `__new_parent` (`id` text PRIMARY KEY NOT NULL, `name` text)",
        "INSERT INTO `__new_parent`(`id`) SELECT `id` FROM `parent`",
        "--> statement-breakpoint\nDROP TABLE `parent`",
        "ALTER TABLE `__new_parent` RENAME TO `parent`",
      ),
    ])).toEqual(["0002: drops parent, which child reference"]);
  });

  it("allows a rebuild of a table nothing references, and a drop of children before their parent", () => {
    expect(dropsOfReferencedTables([
      parentAndChild,
      migration(
        "0002",
        "CREATE TABLE `__new_child` (`id` text PRIMARY KEY NOT NULL, `parent_id` text REFERENCES `parent`(`id`) ON DELETE CASCADE)",
        "DROP TABLE `child`",
        "ALTER TABLE `__new_child` RENAME TO `child`",
      ),
      migration("0003", "DROP TABLE `child`", "DROP TABLE `parent`"),
    ])).toEqual([]);
  });

  it("follows a reference added with a column and a table renamed under it", () => {
    expect(dropsOfReferencedTables([
      migration("0001", "CREATE TABLE `a` (`id` text PRIMARY KEY)", "CREATE TABLE `b` (`id` text PRIMARY KEY)"),
      migration("0002", "ALTER TABLE `b` ADD `a_id` text REFERENCES `a`(`id`)", "ALTER TABLE `a` RENAME TO `a2`"),
      migration("0003", "DROP TABLE `a2`"),
    ])).toEqual(["0003: drops a2, which b reference"]);
  });
});

describe("D1 migration contract", () => {
  it("never drops a table another table references", () => {
    expect(dropsOfReferencedTables(testEnv.TEST_MIGRATIONS)).toEqual([]);
  });

  it("deletes a dropped table's cascading children, which is why the rule above exists", async () => {
    await testEnv.DB.batch([
      testEnv.DB.prepare("CREATE TABLE contract_parent (id TEXT PRIMARY KEY NOT NULL)"),
      testEnv.DB.prepare(
        "CREATE TABLE contract_child (id TEXT PRIMARY KEY NOT NULL, parent_id TEXT NOT NULL REFERENCES contract_parent(id) ON DELETE CASCADE)",
      ),
      testEnv.DB.prepare("INSERT INTO contract_parent (id) VALUES ('p')"),
      testEnv.DB.prepare("INSERT INTO contract_child (id, parent_id) VALUES ('c', 'p')"),
    ]);
    await testEnv.DB.batch([
      testEnv.DB.prepare("PRAGMA defer_foreign_keys = on"),
      testEnv.DB.prepare("CREATE TABLE __new_contract_parent (id TEXT PRIMARY KEY NOT NULL)"),
      testEnv.DB.prepare("INSERT INTO __new_contract_parent (id) SELECT id FROM contract_parent"),
      testEnv.DB.prepare("DROP TABLE contract_parent"),
      testEnv.DB.prepare("ALTER TABLE __new_contract_parent RENAME TO contract_parent"),
    ]);
    const children = await testEnv.DB.prepare("SELECT count(*) AS n FROM contract_child").first<{ n: number }>();
    await testEnv.DB.batch([
      testEnv.DB.prepare("DROP TABLE contract_child"),
      testEnv.DB.prepare("DROP TABLE contract_parent"),
    ]);
    expect(children?.n).toBe(0);
  });

  it("applies every migration under its remote path-qualified name", async () => {
    const ledger = await testEnv.DB.prepare(
      "SELECT id, name FROM d1_migrations ORDER BY id",
    ).all<{ id: number; name: string }>();

    expect(testEnv.TEST_MIGRATIONS.every((migration) => (
      /^\d{14}_[^/]+\/migration\.sql$/.test(migration.name)
    ))).toBe(true);
    expect(ledger.results).toEqual(
      testEnv.TEST_MIGRATIONS.map((migration, index) => ({
        id: index + 1,
        name: migration.name,
      })),
    );
  });

  it("keeps D1-unsafe SQL out and optimizes every schema migration", () => {
    const violations: string[] = [];

    for (const migration of testEnv.TEST_MIGRATIONS) {
      const sql = migration.queries.join("\n");
      if (/PRAGMA\s+(?:defer_)?foreign_keys\s*=/iu.test(sql)) {
        violations.push(`${migration.name}: changes foreign-key enforcement`);
      }
      if (/\bCREATE\s+(?:TEMP|TEMPORARY)\s+(?:TABLE|TRIGGER|INDEX|VIEW)\b/iu.test(sql)) {
        violations.push(`${migration.name}: creates temporary-schema objects`);
      }
      // Wrangler's splitter keeps a statement's leading comments, so the final
      // statement carries Drizzle's `--> statement-breakpoint` line.
      const lastStatement = (migration.queries.at(-1) ?? "").replace(/^(?:\s*--[^\n]*\n)*/u, "").trim();
      if (!/^PRAGMA\s+optimize\s*;?$/iu.test(lastStatement)) {
        violations.push(`${migration.name}: does not finish with PRAGMA optimize`);
      }
    }

    expect(violations).toEqual([]);
  });

  it("matches the latest Drizzle tables and indexes", async () => {
    const declaredTables = latestSnapshot.ddl
      .filter((item) => item.entityType === "tables")
      .map((item) => item.name)
      .sort();
    const actualTables = await testEnv.DB.prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT GLOB '_cf_*' AND name <> 'd1_migrations' ORDER BY name",
    ).all<{ name: string }>();
    expect(actualTables.results.map((row) => row.name)).toEqual(declaredTables);

    const declaredIndexes = latestSnapshot.ddl
      .filter((item) => item.entityType === "indexes")
      .map((item) => item.name)
      .sort();
    const actualIndexes = await testEnv.DB.prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all<{ name: string }>();
    expect(actualIndexes.results.map((row) => row.name)).toEqual(declaredIndexes);
  });

  it("keeps every trigger on the table it guards", async () => {
    const actual = await testEnv.DB.prepare(
      "SELECT tbl_name AS tableName, name FROM sqlite_schema WHERE type = 'trigger' ORDER BY tbl_name, name",
    ).all<{ tableName: string; name: string }>();
    const declared = Object.entries(DATABASE_TRIGGERS)
      .flatMap(([tableName, names]) => names.map((name) => ({ tableName, name })))
      .sort((a, b) => a.tableName.localeCompare(b.tableName) || a.name.localeCompare(b.name));
    expect(actual.results).toEqual(declared);
  });

  it("enforces every declared CHECK and NOT NULL constraint", async () => {
    const tableSql = new Map<string, string>();
    const tableInfo = new Map<string, TableInfoRow[]>();

    for (const item of latestSnapshot.ddl) {
      if (item.entityType !== "tables") continue;
      const table = item.name;
      const schema = await testEnv.DB.prepare(
        "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?",
      ).bind(table).first<{ sql: string }>();
      tableSql.set(table, schema?.sql ?? "");
      const columns = await testEnv.DB.prepare(
        `PRAGMA table_info(${quoteIdentifier(table)})`,
      ).all<TableInfoRow>();
      tableInfo.set(table, columns.results);
    }

    const failures: string[] = [];
    for (const item of latestSnapshot.ddl) {
      if (item.entityType !== "checks" || !item.table || !item.value) continue;
      const sql = tableSql.get(item.table) ?? "";
      const namedConstraintPresent = sql.includes(`"${item.name}"`)
        || sql.includes(`\`${item.name}\``);
      const equivalentExpressionPresent = normalizeSql(sql).includes(normalizeSql(item.value));
      if (!namedConstraintPresent && !equivalentExpressionPresent) {
        failures.push(`declared CHECK ${item.table}.${item.name} is not enforced`);
      }
    }

    for (const item of latestSnapshot.ddl) {
      if (item.entityType !== "columns" || !item.notNull || !item.table) continue;
      const actual = tableInfo.get(item.table)?.find((column) => column.name === item.name);
      if (!actual || !(actual.notnull || actual.pk)) {
        failures.push(`declared NOT NULL ${item.table}.${item.name} is not enforced`);
      }
    }

    for (const [table, columns] of tableInfo) {
      for (const column of columns) {
        if (column.pk === 1 && column.type.toUpperCase() === "TEXT" && column.notnull === 0) {
          failures.push(`${table}.${column.name} is a nullable text primary key`);
        }
      }
    }

    expect(failures).toEqual([]);
  });

  it("matches every declared foreign key", async () => {
    const declaredForeignKeys = new Set<string>();
    for (const item of latestSnapshot.ddl) {
      if (
        item.entityType !== "fks"
        || !item.table
        || !item.tableTo
        || !item.columns
        || !item.columnsTo
        || !item.onDelete
        || !item.onUpdate
      ) continue;
      declaredForeignKeys.add(foreignKeyShape({
        columns: item.columns,
        columnsTo: item.columnsTo,
        onDelete: item.onDelete,
        onUpdate: item.onUpdate,
        table: item.table,
        tableTo: item.tableTo,
      }));
    }

    const actualForeignKeys = new Set<string>();
    for (const item of latestSnapshot.ddl) {
      if (item.entityType !== "tables") continue;
      const foreignKeys = await testEnv.DB.prepare(
        `PRAGMA foreign_key_list(${quoteIdentifier(item.name)})`,
      ).all<ForeignKeyRow>();
      const grouped = new Map<number, ForeignKeyRow[]>();
      for (const row of foreignKeys.results) {
        const rows = grouped.get(row.id) ?? [];
        rows.push(row);
        grouped.set(row.id, rows);
      }
      for (const rows of grouped.values()) {
        rows.sort((left, right) => left.seq - right.seq);
        const first = rows[0];
        if (!first) continue;
        actualForeignKeys.add(foreignKeyShape({
          columns: rows.map((row) => row.from),
          columnsTo: rows.map((row) => row.to),
          onDelete: first.on_delete,
          onUpdate: first.on_update,
          table: item.name,
          tableTo: first.table,
        }));
      }
    }

    expect([...actualForeignKeys].sort()).toEqual([...declaredForeignKeys].sort());
  });
});
