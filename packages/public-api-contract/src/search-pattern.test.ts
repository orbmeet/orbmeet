import * as v from "valibot";
import { describe, expect, it } from "vitest";

import { searchTextSchema } from "./fields";
import { buildD1ContainsPattern, escapeSqliteLike, fitsD1ContainsPattern } from "./search-pattern";

describe("D1 LIKE patterns", () => {
  it("escapes SQLite wildcard and escape characters", () => {
    expect(escapeSqliteLike("100%_done\\")).toBe("100\\%\\_done\\\\");
    expect(buildD1ContainsPattern("100%")).toBe("%100\\%%");
  });

  it("enforces D1's UTF-8 pattern byte limit after escaping", () => {
    expect(fitsD1ContainsPattern("a".repeat(48))).toBe(true);
    expect(fitsD1ContainsPattern("a".repeat(49))).toBe(false);
    expect(fitsD1ContainsPattern("%".repeat(24))).toBe(true);
    expect(fitsD1ContainsPattern("%".repeat(25))).toBe(false);
    expect(fitsD1ContainsPattern("界".repeat(16))).toBe(true);
    expect(fitsD1ContainsPattern("界".repeat(17))).toBe(false);
  });

  it.each([["a".repeat(48), true], ["a".repeat(49), false], ["İ".repeat(24), false], ["İ".repeat(16), true]])(
    "measures the lowercased pattern the query emits: %s",
    (query, valid) => {
      expect(fitsD1ContainsPattern(query)).toBe(valid);
      expect(v.is(searchTextSchema, query)).toBe(valid);
    },
  );
});
