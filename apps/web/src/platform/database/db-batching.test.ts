import { describe, expect, it } from "vitest";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { and, eq, inArray, sql } from "drizzle-orm";
import { boundParameterCount, boundedStatements, chunkArray } from "./db-batching";
import { D1_MAX_BOUND_PARAMETERS } from "./db-limits";

const rows = sqliteTable("rows", {
  id: text("id").primaryKey(),
  owner: text("owner").notNull(),
  note: text("note"),
  size: integer("size").notNull(),
});
const db = drizzle(async () => ({ rows: [] }));

describe("db-batching", () => {
  describe("chunkArray", () => {
    it("chunks arrays evenly when length is a multiple of size", () => {
      expect(chunkArray([1, 2, 3, 4, 5, 6], 2)).toEqual([[1, 2], [3, 4], [5, 6]]);
    });

    it("includes the remainder chunk when length is not a multiple of size", () => {
      expect(chunkArray([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    });

    it("returns empty array for empty input", () => {
      expect(chunkArray([], 5)).toEqual([]);
    });

    it("throws error for non-positive or non-integer size", () => {
      expect(() => chunkArray([1, 2], 0)).toThrow("chunk size must be a positive integer");
      expect(() => chunkArray([1, 2], 1.5)).toThrow("chunk size must be a positive integer");
    });
  });

  describe("boundedStatements", () => {
    const insertOf = (count: number) =>
      Array.from({ length: count }, (_, index) => ({ id: `r${index}`, owner: "o", note: null, size: index }));

    it("builds nothing for no items", () => {
      expect(boundedStatements([], (chunk: string[]) => db.delete(rows).where(inArray(rows.id, chunk)))).toEqual([]);
    });

    it("keeps one statement when everything fits", () => {
      const statements = boundedStatements(["a", "b", "c"], (ids) => db.delete(rows).where(inArray(rows.id, ids)));
      expect(statements).toHaveLength(1);
      expect(boundParameterCount(statements[0])).toBe(3);
    });

    it("sizes multi-row inserts from the row shape, not from a count kept beside it", () => {
      const items = insertOf(250);
      const statements = boundedStatements(items, (chunk) => db.insert(rows).values(chunk).onConflictDoNothing());
      const perRow = boundParameterCount(db.insert(rows).values(items.slice(0, 1)));
      expect(statements).toHaveLength(Math.ceil(250 / Math.floor(D1_MAX_BOUND_PARAMETERS / perRow)));
      for (const statement of statements) {
        expect(boundParameterCount(statement)).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS);
      }
      expect(statements.reduce((sum, statement) => sum + boundParameterCount(statement), 0)).toBe(250 * perRow);
    });

    it("reserves what the statement binds whatever its items", () => {
      const ids = Array.from({ length: 300 }, (_, index) => `id${index}`);
      const statements = boundedStatements(ids, (chunk) =>
        db
          .update(rows)
          .set({ owner: "next", size: 1 })
          .where(and(inArray(rows.id, chunk), eq(rows.owner, "previous"))));
      // Three fixed values: two set, one compared.
      expect(statements.map(boundParameterCount)).toEqual([100, 100, 100, 12]);
    });

    it("packs items of different costs", () => {
      const items = Array.from({ length: 60 }, (_, index) => (index % 2 === 0 ? 1 : 3));
      const statements = boundedStatements(items, (chunk) =>
        db.run(sql`select ${sql.join(chunk.flatMap((n) => Array.from({ length: n }, () => sql`${n}`)), sql`, `)}`));
      expect(statements.map(boundParameterCount)).toEqual([100, 20]);
    });

    it("refuses an item that alone exceeds the cap", () => {
      expect(() =>
        boundedStatements([1, 2], (chunk) =>
          db.run(sql`select ${sql.join(chunk.flatMap(() => Array.from({ length: 101 }, () => sql`${1}`)), sql`, `)}`)),
      ).toThrow(/One item binds 101 parameters/);
    });
  });
});
