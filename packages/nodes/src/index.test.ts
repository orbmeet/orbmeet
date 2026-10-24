import { describe, expect, it } from "vitest";
import { nodeHostnames, parseNodes, placeNode, type PlacementCandidate } from "./index.ts";

const key = (seed: string) => `${seed}-${"k".repeat(40)}`;

function node(overrides: Record<string, unknown> = {}) {
  return {
    media: { url: "wss://sg1.rtc.example.com", capacity: 60, keys: { "sg1-a": "secret" } },
    whiteboard: {
      url: "https://sg1.whiteboard.example.com/",
      jwt: { "sg1-jwt": key("jwt") },
      command: { "sg1-cmd": key("cmd") },
      callback: { "sg1-cb": key("cb") },
    },
    ...overrides,
  };
}

describe("parseNodes", () => {
  it("reads each node's services and indexes every key by the node that holds it", () => {
    const config = parseNodes(JSON.stringify({
      sg1: node(),
      ams1: {
        weight: 0,
        media: { url: "wss://ams1.rtc.example.com", capacity: 120, keys: { "ams1-a": "s1", "ams1-b": "s2" } },
      },
    }));
    const sg1 = config.nodes.get("sg1")!;
    expect(sg1.weight).toBe(1);
    // No region named: the node is a region of its own.
    expect(sg1.region).toBe("sg1");
    expect(parseNodes(JSON.stringify({ sg1: { ...node(), region: "sin" } })).nodes.get("sg1")!.region).toBe("sin");
    expect(sg1.media).toEqual({ url: "wss://sg1.rtc.example.com", capacity: 60, apiKey: "sg1-a", apiSecret: "secret" });
    expect(sg1.whiteboard!.url).toBe("https://sg1.whiteboard.example.com");
    expect(config.nodes.get("ams1")!.whiteboard).toBeNull();
    expect(config.liveKitKeys.get("ams1-b")).toEqual({ node: config.nodes.get("ams1"), secret: "s2" });
    expect(config.whiteboardJwtKeys.get("sg1-jwt")?.node).toBe(sg1);
    expect(config.whiteboardCallbackNodes.get("sg1-cb")).toBe(sg1);
    expect([...config.whiteboardCallbackKeyring.keys()]).toEqual(["sg1-cb"]);
  });

  it.each([
    ["an unknown field", { sg1: node({ location: [1.29, 103.85] }) }, "NODES is invalid at sg1.location"],
    ["a region that is not a name", { sg1: node({ region: "South East Asia" }) }, "NODES is invalid at sg1.region"],
    ["a node running nothing", { sg1: node({ media: undefined, whiteboard: undefined }) }, "must run media, the whiteboard or both"],
    ["a short whiteboard secret", { sg1: node({ whiteboard: { ...node().whiteboard, jwt: { j: "short" } } }) }, "secrets of 32-512"],
    ["a numeric key id", { sg1: node({ media: { ...node().media, keys: { 1: "s" } } }) }, "plain numbers"],
    ["a shared token key id", { sg1: node(), my1: node() }, "LiveKit key id must be unique"],
    ["no nodes", {}, "between 1 and 16 nodes"],
  ])("refuses %s", (_, value, message) => {
    expect(() => parseNodes(JSON.stringify(value))).toThrow(message);
  });

  it("never echoes a secret in its errors", () => {
    expect(() => parseNodes(JSON.stringify({ sg1: node({ media: { url: "nope", capacity: 1, keys: { a: "TOPSECRET" } } }) })))
      .toThrow(/^(?!.*TOPSECRET)/);
  });
});

describe("placeNode", () => {
  const sg1: PlacementCandidate = { id: "sg1", weight: 1 };
  const sg2: PlacementCandidate = { id: "sg2", weight: 1 };
  const ams1: PlacementCandidate = { id: "ams1", weight: 1 };
  // As measured from a Dhaka data centre: Singapore's two nodes about equally fast.
  const fromDhaka = new Map([["sg1", 40], ["sg2", 46], ["ams1", 160]]);
  const latency = (n: PlacementCandidate) => fromDhaka.get(n.id);

  it("goes to the fastest nodes, and among those equally fast to the least loaded for its weight", () => {
    const load = new Map([["sg1", 10], ["sg2", 4], ["ams1", 0]]);
    expect(placeNode([sg1, sg2, ams1], { latency, load: (n) => load.get(n.id)! })).toBe(sg2);
    expect(placeNode([sg1, { ...sg2, weight: 3 }, ams1], { latency, load: () => 6 })?.id).toBe("sg2");
    // Equal load: the faster.
    expect(placeNode([sg1, sg2, ams1], { latency, load: () => 0 })).toBe(sg1);
  });

  it("spills over to slower nodes only when the fast ones are full", () => {
    const load = new Map([["sg1", 60], ["sg2", 60], ["ams1", 5]]);
    const options = { latency, load: (n: PlacementCandidate) => load.get(n.id)!, capacity: () => 60 };
    expect(placeNode([sg1, sg2, ams1], options)).toBe(ams1);
    // Every node full: still placed, on a fast one.
    expect(placeNode([sg1, sg2, ams1], { ...options, capacity: () => 1 })?.id).toMatch(/^sg/);
  });

  it("counts every node in the fastest node's region as near, however its measurement came out", () => {
    // Through a VPN, Singapore's second machine measured 40 ms slower than its first.
    const viaVpn = new Map([["sg1", 60], ["sg2", 100], ["ams1", 180]]);
    const sin = { region: "sin" };
    const load = new Map([["sg1", 30], ["sg2", 2], ["ams1", 0]]);
    const options = { latency: (n: PlacementCandidate) => viaVpn.get(n.id), load: (n: PlacementCandidate) => load.get(n.id)! };
    expect(placeNode([{ ...sg1, ...sin }, { ...sg2, ...sin }, ams1], options)?.id).toBe("sg2");
    // Without regions, 40 ms apart is two different places.
    expect(placeNode([sg1, sg2, ams1], options)?.id).toBe("sg1");
    // A region never pulls in a node from elsewhere.
    expect(placeNode([{ ...sg1, ...sin }, { ...ams1, region: "ams" }], options)?.id).toBe("sg1");
  });

  it("leaves out a node that did not answer the measurement while others did", () => {
    const partial = new Map([["ams1", 160]]);
    expect(placeNode([sg1, ams1], { latency: (n) => partial.get(n.id) })).toBe(ams1);
  });

  it("sends nothing to a retiring node while another answers", () => {
    expect(placeNode([{ ...sg1, weight: 0 }, ams1], { latency })).toBe(ams1);
    expect(placeNode([{ ...sg1, weight: 0 }], { latency })?.id).toBe("sg1");
    expect(placeNode([], { latency })).toBeNull();
  });

  it("without measurements, spreads ties by key rather than by name", () => {
    const chosen = new Set(Array.from({ length: 40 }, (_, i) => placeNode([sg1, ams1], { spreadKey: `board-${i}` })!.id));
    expect(chosen).toEqual(new Set(["sg1", "ams1"]));
    expect(placeNode([sg1, ams1], { spreadKey: "b" })).toBe(placeNode([ams1, sg1], { spreadKey: "b" }));
  });
});

it("names a node's hosts under the app's domain", () => {
  expect(nodeHostnames("example.com", "sg1")).toEqual({
    rtc: "sg1.rtc.example.com", turn: "sg1.turn.example.com", whiteboard: "sg1.whiteboard.example.com",
  });
});
