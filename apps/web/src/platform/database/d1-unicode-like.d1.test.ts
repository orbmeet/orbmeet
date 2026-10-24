import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { SQLiteDialect } from "drizzle-orm/sqlite-core";
import { createTestDb } from "@/test/db";
import { d1UnicodeContains } from "./d1-unicode-like";

// D1 rejects a statement carrying more than 100 bound values. The fold used to
// bind two per distinct case pair in the query, so a phrase-length search
// composed over three columns exceeded the cap before any of the surrounding
// predicates were counted.
const D1_MAX_BOUND_PARAMETERS = 100;

// A phrase whose folds used to produce 108 bound values on their own, and one
// with only non-ASCII pairs so the fold actually has replacements to emit.
const ASCII_PHRASE = "quarterly budget review sync";
const UNICODE_PHRASE = "Ärlig Översikt Über Çalışma";

const dialect = new SQLiteDialect();
const boundParameterCount = (statement: ReturnType<typeof sql>) =>
  dialect.sqlToQuery(statement).params.length;

describe("d1UnicodeContains", () => {
  it("binds one value per fold regardless of query length", () => {
    for (const query of ["a", ASCII_PHRASE, UNICODE_PHRASE, "%_\\".repeat(4)]) {
      expect(boundParameterCount(d1UnicodeContains(sql`'x'`, query))).toBe(1);
    }
  });

  it("runs the composed history search under D1's parameter cap", async () => {
    const db = await createTestDb();
    for (const search of [ASCII_PHRASE, UNICODE_PHRASE]) {
      // The three folds the meeting history composes, over three columns.
      const predicate = sql`(
        ${d1UnicodeContains(sql`coalesce(m.title, m.code)`, search)}
        OR ${d1UnicodeContains(sql`m.starter`, search)}
        OR ${d1UnicodeContains(sql`m.display_name`, search)}
      )`;
      const statement = sql`select 1 from (
        select 'Quarterly Budget Review Sync' as title, 'abc' as code,
               'Ärlig Översikt Über Çalışma' as starter, '' as display_name
      ) m where ${predicate}`;

      expect(boundParameterCount(statement)).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS);
      await expect(db.run(statement)).resolves.toBeDefined();
    }
  });

  it("folds case for both ASCII and Unicode through the database", async () => {
    const db = await createTestDb();
    const row = sql`(select 'Ärlig Överzicht ÅTTA' as v)`;
    const matches = async (query: string) =>
      (await db.all<{ n: number }>(sql`select count(*) as n from ${row} where ${d1UnicodeContains(sql.raw("v"), query)}`))[0]?.n;

    await expect(matches("ärlig")).resolves.toBe(1);
    await expect(matches("ÖVERZICHT")).resolves.toBe(1);
    await expect(matches("åtta")).resolves.toBe(1);
    await expect(matches("nothing")).resolves.toBe(0);
    // The pattern stays wildcard-safe: `_` matches only a literal underscore.
    await expect(matches("Ä_lig")).resolves.toBe(0);
  });

  it("matches exactly what the in-memory recheck matches, for a letter whose capital is two", async () => {
    const db = await createTestDb();
    for (const value of ["Straße", "STRASSE", "strasse"]) {
      const [row] = await db.all<{ n: number }>(
        sql`select count(*) as n from (select ${value} as v) where ${d1UnicodeContains(sql.raw("v"), "straße")}`,
      );
      expect(row?.n === 1).toBe(value.toLocaleLowerCase().includes("straße"));
    }
  });

  it("resolves a full batch of contact names in one statement", async () => {
    const db = await createTestDb();
    // contact-index resolves up to ten names, two folds each, in one query.
    const names = Array.from({ length: 10 }, (_, index) => `Contact Ünïqüe ${index}`);
    const predicate = sql.join(
      names.flatMap((name) => [
        d1UnicodeContains(sql.raw("display_name"), name),
        d1UnicodeContains(sql.raw("email"), name),
      ]),
      sql` OR `,
    );
    const statement = sql`select 1 from (select '' as display_name, '' as email) where ${predicate}`;

    expect(boundParameterCount(statement)).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS);
    await expect(db.run(statement)).resolves.toBeDefined();
  });
});
