import { describe, expect, it, vi } from "vitest";
import { TEST_MEDIA_ENV } from "@/test/nodes";
import { browserNodeLatencies, measureNodeLatencies } from "./node-latency.server";

const NODES = {
  NODES: JSON.stringify({
    sg1: { media: { url: "wss://sg1.rtc.example.com", capacity: 60, keys: { "sg1-key": "s" } } },
    ams1: { media: { url: "wss://ams1.rtc.example.com", capacity: 60, keys: { "ams1-key": "s" } } },
  }),
};

/** A data centre's cache, as the Cache API keeps it. */
function memoryCache() {
  const entries = new Map<string, Response>();
  return {
    entries,
    match: async (request: Request) => entries.get(request.url)?.clone(),
    put: async (request: Request, response: Response) => void entries.set(request.url, response.clone()),
  } as unknown as Cache & { entries: Map<string, Response> };
}

describe("measureNodeLatencies", () => {
  it("times a connection to each node, leaving out one that does not answer", async () => {
    const probe = vi.fn(async (host: string) => (host.startsWith("sg1") ? 38 : undefined));
    await expect(measureNodeLatencies(NODES, "DAC", { probe, cache: null })).resolves.toEqual({ sg1: 38 });
    expect(probe.mock.calls.map(([host]) => host).sort()).toEqual(["ams1.rtc.example.com", "sg1.rtc.example.com"]);
  });

  it("measures once per data centre while its cache holds, and again for a changed node list", async () => {
    const cache = memoryCache();
    const probe = vi.fn(async (host: string) => (host.startsWith("sg1") ? 38 : 160));

    await measureNodeLatencies(NODES, "DAC", { probe, cache });
    await expect(measureNodeLatencies(NODES, "DAC", { probe, cache })).resolves.toEqual({ sg1: 38, ams1: 160 });
    expect(probe).toHaveBeenCalledTimes(2);

    // Another data centre has its own numbers.
    await measureNodeLatencies(NODES, "LHR", { probe, cache });
    expect(probe).toHaveBeenCalledTimes(4);

    // A replaced node is measured at once, not after the cache expires.
    await measureNodeLatencies(TEST_MEDIA_ENV, "DAC", { probe, cache });
    expect(probe).toHaveBeenCalledTimes(5);
    expect([...cache.entries.values()][0].headers.get("Cache-Control")).toBe("max-age=600");
  });

  it("measures nothing for an unusable NODES", async () => {
    const probe = vi.fn();
    await expect(measureNodeLatencies({ NODES: "" }, "DAC", { probe, cache: null })).resolves.toEqual({});
    expect(probe).not.toHaveBeenCalled();
  });
});

describe("browserNodeLatencies", () => {
  it("keeps what the browser measured to nodes NODES lists", () => {
    expect(browserNodeLatencies(NODES, { sg1: 41, ams1: 170, gone1: 5 })).toEqual({ sg1: 41, ams1: 170 });
  });

  it("gives nothing to place by when the browser measured no node NODES lists", () => {
    expect(browserNodeLatencies(NODES, undefined)).toBeNull();
    expect(browserNodeLatencies(NODES, {})).toBeNull();
    expect(browserNodeLatencies(NODES, { gone1: 5 })).toBeNull();
    expect(browserNodeLatencies({ NODES: "" }, { sg1: 41 })).toBeNull();
  });
});
