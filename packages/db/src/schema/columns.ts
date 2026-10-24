import { customType } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

// Billing webhook timestamps are migrating from epoch seconds to epoch
// milliseconds. Deployments apply D1 migrations before activating the new
// Worker, and gradual deployments may briefly keep both Worker versions live.
// Accept both encodings while making every new write millisecond-precise.
export const billingEventTimestamp = customType<{
  data: Date;
  driverData: number;
}>({
  dataType() {
    return "integer";
  },
  fromDriver(value) {
    const milliseconds = Math.abs(value) < 100_000_000_000 ? value * 1000 : value;
    return new Date(milliseconds);
  },
  toDriver(value) {
    return value.getTime();
  },
});

// Anything schema-expressible about the product model is
// enforced here (SQLite ALTERs that touch FKs or CHECKs rebuild the table, so
// constraints are front-loaded). Deletion follows "cascade down, restrict
// up": leaves cascade with their aggregate root, cross-aggregate FKs RESTRICT,
// and hard deletion is an orchestrated app path in dependency order.

export const JSON_TEXT_MAX_LENGTH = 32_768;

export function oneOf(column: unknown, values: readonly string[]) {
  // Only pass compile-time constant enums here. This helper uses sql.raw() to
  // emit literal values inside CHECK constraints, so dynamic user input would
  // be unsafe.
  return sql`${column} in (${sql.join(
    values.map((value) => sql.raw(`'${value.replace(/'/g, "''")}'`)),
    sql.raw(", "),
  )})`;
}

export function requiredTrimmedTextLength(column: unknown, max: number) {
  return sql`length(${column}) <= ${sql.raw(String(max))} AND length(trim(${column})) BETWEEN 1 AND ${sql.raw(String(max))}`;
}

export function optionalTextLength(column: unknown, max: number) {
  return sql`${column} IS NULL OR length(${column}) <= ${sql.raw(String(max))}`;
}

export function optionalExactTextLength(column: unknown, length: number) {
  return sql`${column} IS NULL OR length(${column}) = ${sql.raw(String(length))}`;
}

export function meetingCodeShape(column: unknown) {
  const letterPositions = [1, 2, 3, 5, 6, 7, 8, 10, 11, 12];
  const letterChecks = sql.join(
    letterPositions.map((position) => sql`substr(${column}, ${sql.raw(String(position))}, 1) BETWEEN 'a' AND 'z'`),
    sql.raw(" AND "),
  );

  // Avoid SQLite GLOB here: D1 can reject this specific pattern in CHECK constraints
  // with "LIKE or GLOB pattern too complex" during inserts. Explicit position checks
  // preserve the same xxx-xxxx-xxx contract without relying on GLOB.
  return sql`
    length(${column}) = 12
    AND substr(${column}, 4, 1) = '-'
    AND substr(${column}, 9, 1) = '-'
    AND lower(${column}) = ${column}
    AND ${letterChecks}
  `;
}

// R2 key shape checks use substr(): D1 caps LIKE patterns at 50 bytes and GLOB
// is unreliable inside CHECK constraints. Key derivation lives in
// apps/web/src/platform/storage/r2-keys.ts; these checks only pin the retention-class prefix.
