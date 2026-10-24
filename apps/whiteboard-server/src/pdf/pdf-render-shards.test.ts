import { describe, it, expect } from "vitest";
import { parsePdfPageRange, planRenderShards } from "./pdf-import-contract.ts";

/** Every page in 1..pageCount covered exactly once, in order. */
function coverage(shards: { first: number; last: number }[]): number[] {
  return shards.flatMap((shard) =>
    Array.from({ length: shard.last - shard.first + 1 }, (_, i) => shard.first + i));
}

describe("planRenderShards", () => {
  it("covers every page exactly once with no gaps or overlaps", () => {
    // mutool renders the *last* page of a document for a range entirely past
    // the end, so an over-long shard would silently duplicate it into the
    // import. Exact coverage is the property that prevents that.
    for (const pageCount of [1, 2, 3, 4, 5, 7, 8, 12, 16, 17, 49, 50, 100]) {
      for (const budget of [1, 2, 3, 4, 6]) {
        const shards = planRenderShards(pageCount, budget);
        expect(coverage(shards), `pages=${pageCount} budget=${budget}`).toEqual(
          Array.from({ length: pageCount }, (_, i) => i + 1),
        );
      }
    }
  });

  it("never plans a shard past the requested page count", () => {
    for (const pageCount of [1, 5, 16, 50]) {
      for (const shard of planRenderShards(pageCount, 6)) {
        expect(shard.last).toBeLessThanOrEqual(pageCount);
        expect(shard.first).toBeGreaterThanOrEqual(1);
        expect(shard.first).toBeLessThanOrEqual(shard.last);
      }
    }
  });

  it("never exceeds the process budget", () => {
    for (const pageCount of [4, 16, 50, 100]) {
      for (const budget of [1, 2, 4, 6]) {
        expect(planRenderShards(pageCount, budget).length).toBeLessThanOrEqual(budget);
      }
    }
  });

  it("stays serial for small documents where process startup dominates", () => {
    expect(planRenderShards(1, 4)).toEqual([{ first: 1, last: 1 }]);
    expect(planRenderShards(3, 4)).toEqual([{ first: 1, last: 3 }]);
  });

  it("shards a 16-page import across the full budget", () => {
    expect(planRenderShards(16, 4)).toEqual([
      { first: 1, last: 4 },
      { first: 5, last: 8 },
      { first: 9, last: 12 },
      { first: 13, last: 16 },
    ]);
  });

  it("shards a selected range using the source PDF's page numbers", () => {
    expect(planRenderShards(91, 4, 50)).toEqual([
      { first: 50, last: 72 },
      { first: 73, last: 95 },
      { first: 96, last: 118 },
      { first: 119, last: 140 },
    ]);
  });

  it("collapses to one process when concurrent renders consume the budget", () => {
    // Three imports in flight leaves each a budget of 1, which is what keeps
    // 3 concurrent 16-page renders from all hitting the 30s render timeout.
    expect(planRenderShards(16, 1)).toEqual([{ first: 1, last: 16 }]);
  });

  it("returns no work for an empty document", () => {
    expect(planRenderShards(0, 4)).toEqual([]);
  });
});

describe("parsePdfPageRange", () => {
  it("accepts up to 100 selected pages from a longer PDF", () => {
    const url = new URL("https://whiteboard.example/pdf-import?pageStart=50&pageEnd=140");
    expect(parsePdfPageRange(url, 200)).toEqual({ start: 50, end: 140, count: 91 });
  });

  it("keeps whole-document imports for PDFs of up to 100 pages", () => {
    expect(parsePdfPageRange(new URL("https://whiteboard.example/pdf-import"), 100))
      .toEqual({ start: 1, end: 100, count: 100 });
  });

  it("requires a range for longer PDFs and rejects invalid selections", () => {
    const base = "https://whiteboard.example/pdf-import";
    expect(parsePdfPageRange(new URL(base), 101)).toBeNull();
    expect(parsePdfPageRange(new URL(`${base}?pageStart=50`), 200)).toBeNull();
    expect(parsePdfPageRange(new URL(`${base}?pageStart=0&pageEnd=10`), 200)).toBeNull();
    expect(parsePdfPageRange(new URL(`${base}?pageStart=50&pageEnd=150`), 200)).toBeNull();
    expect(parsePdfPageRange(new URL(`${base}?pageStart=50&pageEnd=201`), 200)).toBeNull();
  });
});
