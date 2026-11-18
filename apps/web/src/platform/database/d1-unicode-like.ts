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
 * Case folds that lowercasing alone does not perform, as Unicode's CaseFolding
 * table states them: the final sigma folds to the medial one, so "ΟΔΟΣ",
 * "οδος" and "οδοσ" are one word.
 */
const FOLD_OVERRIDES: ReadonlyMap<string, string> = new Map([["ς", "σ"]]);

/**
 * One character's case fold. Folded one character at a time on both sides of
 * the comparison: lowercasing a whole string is context-sensitive (a word-final
 * Σ becomes ς), while the column can only be folded character by character.
 */
function foldCharacter(character: string): string {
  const lower = character.toLowerCase();
  return FOLD_OVERRIDES.get(lower) ?? lower;
}

/** The spellings of a character that fold to `target`. */
function variantsOf(character: string, target: string): string[] {
  const sources = [character, ...[...FOLD_OVERRIDES].filter(([, to]) => to === target).map(([from]) => from)];
  return sources.flatMap((source) => [source, source.toUpperCase(), source.toLowerCase()]);
}

/**
 * D1's built-in lower() only folds ASCII. Extend it with the concrete Unicode
 * case pairs present in the query, keeping filtering in SQL and wildcard-safe.
 *
 * Binds exactly one value — the LIKE pattern — however long the query is, so a
 * caller can compose folds without tracking a per-character parameter budget.
 */
export function d1UnicodeContains(column: SQLWrapper, query: string): SQL {
  const foldedQuery = Array.from(query, foldCharacter).join("");
  let foldedColumn: SQL = sql`lower(${column})`;
  const replacements = new Map<string, string>();

  for (const character of query) {
    const target = foldCharacter(character);
    for (const variant of variantsOf(character, target)) {
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
