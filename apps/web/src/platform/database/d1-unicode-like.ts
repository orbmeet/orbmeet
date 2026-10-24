import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { buildD1ContainsPattern } from "@orbmeet/public-api-contract/search-pattern";

/**
 * `char(…)` over the code points of `value`.
 *
 * The fold pairs are derived from the search text, so binding them was the
 * obvious choice — and it made the parameter count grow with the input. Three
 * folds of a 28-character phrase reached 108 bound values, past D1's cap of
 * 100, and composing folds (one per name in a batch, or one per searched
 * column) multiplied that further. Emitting the pair as `char(196)` instead
 * keeps the statement's parameter count independent of the query: the only
 * text in the SQL is a list of integers this module computed itself, so
 * nothing user-supplied is ever interpolated.
 */
function charLiteral(value: string): SQL {
  const codePoints = Array.from(value, (character) => character.codePointAt(0) ?? 0);
  return sql.raw(`char(${codePoints.join(",")})`);
}

/**
 * D1's built-in lower() only folds ASCII. Extend it with the concrete Unicode
 * case pairs present in the query, keeping filtering in SQL and wildcard-safe.
 *
 * Binds exactly one value — the LIKE pattern — however long the query is, so a
 * caller can compose folds without tracking a per-character parameter budget.
 */
export function d1UnicodeContains(column: SQLWrapper, query: string): SQL {
  const foldedQuery = query.toLowerCase();
  let foldedColumn: SQL = sql`lower(${column})`;
  const replacements = new Map<string, string>();

  for (const character of query) {
    const target = character.toLowerCase();
    for (const variant of [character, character.toUpperCase(), target]) {
      if (variant === target || variant.length === 0) continue;
      // The replacements run on lower()'s output, in which no ASCII capital is
      // left: a variant spelled with one (A for a, or SS for ß) can never be
      // found, so stating it only lengthens the statement.
      if (/[A-Z]/.test(variant)) continue;
      replacements.set(variant, target);
    }
  }
  for (const [variant, target] of replacements) {
    foldedColumn = sql`replace(${foldedColumn}, ${charLiteral(variant)}, ${charLiteral(target)})`;
  }

  return sql`${foldedColumn} LIKE ${buildD1ContainsPattern(foldedQuery)} ESCAPE '\\'`;
}
