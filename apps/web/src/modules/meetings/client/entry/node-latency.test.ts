import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  measureNodeLatencies,
  prefetchNodeLatencies,
  resetNodeLatencies,
  settledNodeLatencies,
  type MeasureDeps,
} from "./node-latency";

/**
 * A network where each node answers after a series of delays, on Vitest's
 * fake clock, so nodes measured at once overlap as they would in a browser.
 */
function network(delays: Record<string, number[] | "down">): MeasureDeps & { requests: string[] } {
  const served = new Map<string, number>();
  const requests: string[] = [];
  return {
    requests,
    now: () => Date.now(),
    fetch: async (url, init) => {
      requests.push(url);
      expect(init).toMatchObject({ mode: "no-cors", cache: "no-store", credentials: "omit" });
      const node = new URL(url).hostname.split(".")[0];
      const series = delays[node];
      if (series === "down") throw new TypeError("Failed to fetch");
      const index = served.get(node) ?? 0;
      served.set(node, index + 1);
      await new Promise((resolve) => setTimeout(resolve, series[Math.min(index, series.length - 1)]));
    },
  };
}

/** Run `work` to completion on the fake clock. */
async function settle<T>(work: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync();
  return work;
}

const sg1 = { id: "sg1", url: "https://sg1.rtc.example.com/" };
const ams1 = { id: "ams1", url: "https://ams1.rtc.example.com/" };

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  resetNodeLatencies();
  vi.useRealTimers();
});

describe("measureNodeLatencies", () => {
  it("times the fastest request after the one that opens the connection", async () => {
    // The first request pays for DNS, TCP and TLS; it is not counted.
    const net = network({ sg1: [400, 52, 47, 60] });
    expect(await settle(measureNodeLatencies([sg1], net))).toEqual({ sg1: 47 });
    expect(net.requests).toEqual([0, 1, 2, 3].map((n) => `${sg1.url}?probe=${n}`));
  });

  it("leaves out a node that does not answer", async () => {
    const net = network({ sg1: [40], ams1: "down" });
    expect(await settle(measureNodeLatencies([sg1, ams1], net))).toEqual({ sg1: 40 });
  });
});

describe("prefetchNodeLatencies", () => {
  it("measures once while fresh, and hands the result to the join", async () => {
    const net = network({ sg1: [40], ams1: [160] });
    prefetchNodeLatencies([sg1, ams1], net);
    prefetchNodeLatencies([ams1, sg1], net);
    expect(await settle(settledNodeLatencies(5_000))).toEqual({ sg1: 40, ams1: 160 });
    expect(net.requests).toHaveLength(8);
  });

  it("never holds a join longer than it is allowed to wait", async () => {
    prefetchNodeLatencies([sg1], { now: () => 0, fetch: () => new Promise(() => {}) });
    const settled = settledNodeLatencies(800);
    await vi.advanceTimersByTimeAsync(800);
    expect(await settled).toBeUndefined();
  });

  it("gives nothing when nothing was measured or nothing answered", async () => {
    expect(await settle(settledNodeLatencies(100))).toBeUndefined();
    prefetchNodeLatencies([ams1], network({ ams1: "down" }));
    expect(await settle(settledNodeLatencies(1_000))).toBeUndefined();
  });
});
