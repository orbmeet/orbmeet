import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { OPS } from "./catalog.ts";
import { loadInventory, mediaNodes, rtcHost, turnHost, whiteboardHost, whiteboardNodes } from "./inventory.ts";
import { INVENTORY, inventory } from "./test-fixtures.ts";

// The production inventory stays on the operator's machine (.gitignore): a
// clone without it, CI's, checks the fixtures alone.
const PRODUCTION = join(OPS, "inventory.json");

describe("inventory", () => {
  it.skipIf(!existsSync(PRODUCTION))("accepts the production inventory", () => {
    const inv = loadInventory(JSON.parse(readFileSync(PRODUCTION, "utf8")));
    expect(mediaNodes(inv).length).toBeGreaterThan(0);
  });

  it("expands services to containers and fills defaults", () => {
    const inv = loadInventory(INVENTORY);
    expect(mediaNodes(inv)).toEqual(["sg1", "my1"]);
    expect(whiteboardNodes(inv)).toEqual(["sg1"]);
    expect(inv.nodes.sg1.containers).toEqual(["caddy", "livekit", "redis", "egress", "transcription", "whiteboard"]);
    expect(inv.nodes.my1.containers).toEqual(["caddy", "livekit", "redis", "egress", "transcription"]);
    expect(inv.nodes.my1.weight).toBe(1);
    // No region given: the node is a region of its own.
    expect(inv.nodes.my1.region).toBe("my1");
    expect(rtcHost(inv, "my1")).toBe("my1.rtc.app.example.com");
    expect(turnHost(inv, "my1")).toBe("my1.turn.app.example.com");
    expect(whiteboardHost(inv, "sg1")).toBe("sg1.whiteboard.app.example.com");
  });

  it("lets any number of nodes run the whiteboard, or none", () => {
    expect(whiteboardNodes(loadInventory(inventory({ my1: { services: ["media", "whiteboard"], memory: "16g" } }))))
      .toEqual(["sg1", "my1"]);
    expect(whiteboardNodes(loadInventory(inventory({ sg1: { services: ["media"] } })))).toEqual([]);
  });

  it.each([
    [{ sg1: { services: ["whiteboard"], media_capacity: undefined } }, "whiteboard runs only beside media"],
    [{ sg1: { services: ["whiteboard"] } }, "media_capacity is a positive integer, given exactly when the node runs media"],
    [{ sg1: { weight: 0 }, my1: { weight: 0 } }, "nonzero weight"],
  ])("refuses %j", (changes, message) => {
    expect(() => loadInventory(inventory(changes))).toThrow(message);
  });

  it.each([
    ["ipv4", "203.0.113.20\nPostUp = id"], ["ipv4", "203.0.113.10"], ["ipv6", "not-an-address"],
    ["interface", "ens5; reboot"], ["ssh", "-oProxyCommand=id"], ["services", []], ["services", "media"],
    ["services", ["media", "media"]], ["services", ["recording"]], ["weight", -1], ["weight", 101],
    ["weight", true], ["weight", "2"], ["region", "South East Asia"], ["region", 1], ["location", [1.29, 103.85]], ["memory", undefined], ["memory", "8 GB"],
    ["media_capacity", undefined], ["media_capacity", 0], ["media_capacity", 2.5], ["memory_limits", { whiteboard: "1g" }],
    ["memory_limits", { livekit: "lots" }], ["livekit_mem_limit", "3g"], ["primary", true],
  ])("rejects %s = %j", (field, value) => {
    expect(() => loadInventory(inventory({ my1: { [field]: value } }))).toThrow();
  });

  it("fits every node's containers in its memory, with the host's reserve", () => {
    const inv = loadInventory(INVENTORY);
    expect(inv.nodes.sg1.memoryLimits).toEqual({
      caddy: "256m", livekit: "4g", redis: "512m", egress: "4g", transcription: "2g", whiteboard: "2g",
    });
    expect(inv.nodes.my1.memoryLimits.livekit).toBe("2g");
    expect(inv.nodes.my1.mediaCapacity).toBe(30);
    // my1's 7424m of limits fit in 8g less 512m; a gigabyte more does not.
    expect(() => loadInventory(inventory({ my1: { memory_limits: { livekit: "3g", egress: "3g", transcription: "1536m" } } })))
      .toThrow("my1: its containers' memory limits total 8448m, more than the 7680m");
  });

  it("lets a node take no new meetings, but not every node", () => {
    expect(loadInventory(inventory({ my1: { weight: 0 } })).nodes.my1.weight).toBe(0);
    expect(() => loadInventory(inventory({ sg1: { weight: 0 }, my1: { weight: 0 } }))).toThrow("nonzero weight");
  });

  it("rejects bad names and app URLs", () => {
    const data = inventory() as { nodes: Record<string, unknown> };
    data.nodes.My_1 = data.nodes.my1;
    delete data.nodes.my1;
    expect(() => loadInventory(data)).toThrow("Node name");
    for (const app of ["http://app.example.com", "https://app.example.com/", "https://localhost"]) {
      expect(() => loadInventory({ ...inventory(), app_url: app })).toThrow("app_url");
    }
  });

  it("writes IPv6 addresses the way DNS answers print them", () => {
    const inv = loadInventory(inventory({ sg1: { ipv6: "2001:DB8:0:0:0:0:0:10" } }));
    expect(inv.nodes.sg1.ipv6).toBe("2001:db8::10");
  });
});
