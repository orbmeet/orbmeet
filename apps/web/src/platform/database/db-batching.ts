import type { Database } from "@orbmeet/db";
import { D1_MAX_BOUND_PARAMETERS } from "./db-limits";

/** One statement of a D1 batch, as Drizzle builds it. */
export type BatchStatement = Parameters<Database["batch"]>[0][number];

export function chunkArray<T>(items: T[], size: number): T[][] {
  if (!Number.isInteger(size) || size < 1) throw new Error("chunk size must be a positive integer");
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

/**
 * A statement whose bound parameters can be read before it runs: a Drizzle
 * query builder (`toSQL`) or a raw `db.run`/`db.all` (`getQuery`).
 */
export type MeasurableStatement =
  | { toSQL(): { params: unknown[] } }
  | { getQuery(): { params: unknown[] } };

export function boundParameterCount(statement: MeasurableStatement): number {
  return ("toSQL" in statement ? statement.toSQL() : statement.getQuery()).params.length;
}

/**
 * The statements `build` makes of `items`, split as D1's bound-parameter cap
 * requires and no further.
 *
 * Each split is measured from the statements themselves, never from a count
 * kept beside them: what the statement binds whatever its items (its
 * `reserved` parameters) is what one item and two items have in common, and
 * each item costs what it adds to that. A column added to a row, a value
 * bound instead of inlined, or a new condition in the WHERE moves the splits
 * with it. Every statement returned is checked against the cap, so a builder
 * whose cost is not one fixed part plus one part per item fails here rather
 * than in D1.
 */
export function boundedStatements<T, S extends MeasurableStatement>(
  items: readonly T[],
  build: (chunk: T[]) => S,
): S[] {
  if (items.length === 0) return [];
  const costOf = (chunk: T[]) => boundParameterCount(build(chunk));
  const reserved = items.length === 1
    ? 0
    : costOf([items[0]]) + costOf([items[1]]) - costOf([items[0], items[1]]);

  const chunks: T[][] = [];
  let chunk: T[] = [];
  let used = reserved;
  for (const item of items) {
    const cost = costOf([item]) - reserved;
    if (reserved + cost > D1_MAX_BOUND_PARAMETERS) {
      throw new Error(`One item binds ${reserved + cost} parameters; D1 allows ${D1_MAX_BOUND_PARAMETERS} per statement`);
    }
    if (chunk.length > 0 && used + cost > D1_MAX_BOUND_PARAMETERS) {
      chunks.push(chunk);
      chunk = [];
      used = reserved;
    }
    chunk.push(item);
    used += cost;
  }
  chunks.push(chunk);

  return chunks.map((part) => {
    const statement = build(part);
    const bound = boundParameterCount(statement);
    if (bound > D1_MAX_BOUND_PARAMETERS) {
      throw new Error(`A statement binds ${bound} parameters; D1 allows ${D1_MAX_BOUND_PARAMETERS}`);
    }
    return statement;
  });
}
