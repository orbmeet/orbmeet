import { describe, expect, it } from "vitest";
import { mapWithConcurrency } from "./map-with-concurrency.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("mapWithConcurrency", () => {
  it("returns results in input order regardless of completion order", async () => {
    const results = await mapWithConcurrency([30, 20, 10], 3, async (delay, index) => {
      await new Promise((resolve) => setTimeout(resolve, delay));
      return `${index}:${delay}`;
    });

    expect(results).toEqual(["0:30", "1:20", "2:10"]);
  });

  it("passes the item and its index", async () => {
    const seen: Array<[string, number]> = [];
    await mapWithConcurrency(["a", "b"], 1, async (item, index) => {
      seen.push([item, index]);
    });

    expect(seen).toEqual([["a", 0], ["b", 1]]);
  });

  it("never runs more than `concurrency` workers at once", async () => {
    let inFlight = 0;
    let peak = 0;

    await mapWithConcurrency(Array.from({ length: 12 }, (_, i) => i), 3, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      await Promise.resolve();
      inFlight -= 1;
    });

    expect(peak).toBe(3);
  });

  it("starts the next item as soon as a slot frees rather than in fixed batches", async () => {
    const gates = [deferred<void>(), deferred<void>(), deferred<void>()];
    const started: number[] = [];

    const run = mapWithConcurrency([0, 1, 2], 2, async (index) => {
      started.push(index);
      await gates[index].promise;
    });

    await Promise.resolve();
    expect(started).toEqual([0, 1]);

    // Freeing one slot must admit the third item immediately.
    gates[0].resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual([0, 1, 2]);

    gates[1].resolve();
    gates[2].resolve();
    await run;
  });

  it("short-circuits on an empty input without invoking the worker", async () => {
    let calls = 0;
    const results = await mapWithConcurrency([], 4, async () => {
      calls += 1;
    });

    expect(results).toEqual([]);
    expect(calls).toBe(0);
  });

  it("clamps a concurrency below one instead of stalling", async () => {
    const results = await mapWithConcurrency([1, 2], 0, async (value) => value * 2);
    expect(results).toEqual([2, 4]);
  });

  it("propagates a worker rejection", async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (value) => {
        if (value === 2) throw new Error("boom");
        return value;
      }),
    ).rejects.toThrow("boom");
  });
});

describe("mapWithConcurrency failure settling", () => {
  it("settles every in-flight worker before rethrowing", async () => {
    // The caller's catch block has to be able to clean up what already landed.
    // With Promise.all's early rejection, cleanup ran while siblings were still
    // mid-write, so a straggler could land its object right after cleanup had
    // enumerated what to delete.
    const finished: number[] = [];
    let release: (() => void) | null = null;
    const slowStarted = new Promise<void>((resolve) => {
      release = resolve;
    });

    const run = mapWithConcurrency([0, 1], 2, async (item) => {
      if (item === 0) {
        await slowStarted;
        finished.push(0);
        return 0;
      }
      throw new Error("boom");
    });

    // Let the rejection happen first, then release the straggler.
    await Promise.resolve();
    release!();

    await expect(run).rejects.toThrow("boom");
    expect(finished).toEqual([0]);
  });

  it("stops handing out new items once one has failed", async () => {
    const seen: number[] = [];

    await expect(
      mapWithConcurrency([0, 1, 2, 3, 4, 5], 1, async (item) => {
        seen.push(item);
        if (item === 1) throw new Error("boom");
        return item;
      }),
    ).rejects.toThrow("boom");

    expect(seen).toEqual([0, 1]);
  });

  it("reports the first rejection when several fail", async () => {
    await expect(
      mapWithConcurrency([0, 1], 2, async (item) => {
        if (item === 0) throw new Error("first");
        await Promise.resolve();
        throw new Error("second");
      }),
    ).rejects.toThrow("first");
  });
});

it.each([NaN, Infinity, -Infinity])("rejects nonfinite concurrency %s before running a worker", async (concurrency) => {
  let calls = 0;
  await expect(mapWithConcurrency([1, 2], concurrency, async () => { calls++; })).rejects.toThrow(RangeError);
  expect(calls).toBe(0);
});
