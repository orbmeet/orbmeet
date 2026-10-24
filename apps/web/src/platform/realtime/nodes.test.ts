import { describe, expect, it } from "vitest";
import {
  mediaNodeHosts,
  mediaNodeKey,
  mediaNodeProbes,
  mediaNodes,
  nodeHosts,
  whiteboardCallbackKeyring,
  whiteboardCallbackNodeId,
  whiteboardJwtKeyring,
  whiteboardNodes,
} from "./nodes";

// NODES itself is parsed and tested in @orbmeet/nodes; these are the Worker's views of it.

const key = (seed: string) => `${seed}-${"k".repeat(40)}`;
const env = (value: unknown) => ({ NODES: typeof value === "string" ? value : JSON.stringify(value) });

const NODES = env({
  sg1: {
    weight: 2,
    media: { url: "wss://sg1.rtc.example.com/", capacity: 60, keys: { "sg1-new": "s-new", "sg1-old": "s-old" } },
    whiteboard: {
      url: "https://sg1.whiteboard.example.com",
      jwt: { "sg1-jwt": key("sg1-jwt") },
      command: { "sg1-cmd": key("sg1-cmd") },
      callback: { "sg1-cb": key("sg1-cb") },
    },
  },
  // A node running only media, retiring.
  my1: { weight: 0, media: { url: "wss://my1.rtc.example.com", capacity: 30, keys: { "my1-key": "s" } } },
});

describe("node views", () => {
  it("gives each service its own view of a node", () => {
    expect([...mediaNodes(NODES).values()]).toEqual([
      {
        id: "sg1", region: "sg1", weight: 2,
        url: "wss://sg1.rtc.example.com", capacity: 60, apiKey: "sg1-new", apiSecret: "s-new",
      },
      {
        id: "my1", region: "my1", weight: 0,
        url: "wss://my1.rtc.example.com", capacity: 30, apiKey: "my1-key", apiSecret: "s",
      },
    ]);
    const [whiteboard] = whiteboardNodes(NODES).values();
    expect(whiteboard).toMatchObject({ id: "sg1", weight: 2, whiteboardUrl: "https://sg1.whiteboard.example.com" });
    expect([...whiteboard.commandKeyring.keys()]).toEqual(["sg1-cmd"]);
    expect(whiteboardNodes(NODES).size).toBe(1);
  });

  it("throws on an unusable NODES, naming it and no secret", () => {
    expect(() => mediaNodes(env(""))).toThrow(/NODES/);
    const secret = "do-not-print-this-secret";
    expect(() => mediaNodes(env({ sg1: { media: { url: "nope", capacity: 1, keys: { k: secret } } } })))
      .toThrow(expect.objectContaining({ message: expect.not.stringContaining(secret) }));
  });

  it("finds a media node by any key in its keyring", () => {
    expect(mediaNodeKey(NODES, "sg1-old")).toMatchObject({ node: { id: "sg1" }, secret: "s-old" });
    expect(mediaNodeKey(NODES, "my1-key")?.node.id).toBe("my1");
    expect(mediaNodeKey(NODES, "other")).toBeNull();
  });

  it("verifies tokens and calls with every node's keys, and names the node by its key", () => {
    expect([...whiteboardJwtKeyring(NODES).keys()]).toEqual(["sg1-jwt"]);
    expect([...whiteboardCallbackKeyring(NODES).keys()]).toEqual(["sg1-cb"]);
    expect(whiteboardCallbackNodeId(NODES, "sg1-cb")).toBe("sg1");
    expect(whiteboardCallbackNodeId(NODES, "sg1-cmd")).toBeNull();
  });

  it("names each node's machine by a host of its own, where its latency is measured to", () => {
    expect(Object.fromEntries(nodeHosts(NODES))).toEqual({ sg1: "sg1.rtc.example.com", my1: "my1.rtc.example.com" });
  });

  it("lists media hosts for the CSP, and none for an unusable configuration", () => {
    expect(mediaNodeHosts(env({
      dev: { media: { url: "ws://localhost:7880", capacity: 1, keys: { devkey: "secret" } } },
      sg1: { media: { url: "wss://sg1.example.com", capacity: 1, keys: { "sg1-key": "s" } } },
    }))).toEqual(["localhost:7880", "sg1.example.com"]);
    expect(mediaNodeHosts(env("{"))).toEqual([]);
  });

  it("points a browser's latency probe at each media node's signalling origin", () => {
    expect(mediaNodeProbes(env({
      dev: { media: { url: "ws://localhost:7880", capacity: 1, keys: { devkey: "secret" } } },
      sg1: { region: "sin", media: { url: "wss://sg1.example.com", capacity: 1, keys: { "sg1-key": "s" } } },
    }))).toEqual([
      { id: "dev", url: "http://localhost:7880/" },
      { id: "sg1", url: "https://sg1.example.com/" },
    ]);
    expect(mediaNodeProbes(env("{"))).toEqual([]);
  });
});
