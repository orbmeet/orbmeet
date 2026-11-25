import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NODE_DIR } from "./catalog.ts";
import { applyMonitors, MONITORS, NODE_ERROR_LEVELS, NOTIFIER, type AxiomApi } from "./monitors.ts";

function fakeAxiom(monitors: { id: string; name: string }[], notifiers = [{ id: "n1", name: NOTIFIER }]) {
  const sent: [string, string, unknown?][] = [];
  const api: AxiomApi = {
    get: async (path) => (path === "/v2/notifiers" ? notifiers : monitors),
    send: async (method, path, body) => {
      sent.push(body === undefined ? [method, path] : [method, path, body]);
    },
  };
  return { api, sent };
}

describe("applyMonitors", () => {
  it("creates what is missing, updates what exists and deletes our own that are gone", async () => {
    const { api, sent } = fakeAxiom([
      { id: "m-error", name: "Orb Meet: error" },
      { id: "m-old", name: "Orb Meet: something failed" },
      { id: "m-theirs", name: "Billing: refunds" },
    ]);
    await applyMonitors(api, () => {});
    expect(sent.map(([method, path]) => `${method} ${path}`)).toEqual([
      // Deleted first: the free plan allows three monitors in all.
      "DELETE /v2/monitors/m-old",
      "PUT /v2/monitors/m-error",
      ...MONITORS.slice(1).map(() => "POST /v2/monitors"),
    ]);
    for (const [, , body] of sent.slice(1)) expect(body).toMatchObject({ notifierIds: ["n1"] });
  });

  it("refuses to run without the notifier the monitors alert through", async () => {
    const { api, sent } = fakeAxiom([], []);
    await expect(applyMonitors(api, () => {})).rejects.toThrow(NOTIFIER);
    expect(sent).toEqual([]);
  });

  it("names only fields the query can rely on", () => {
    for (const { aplQuery } of MONITORS) {
      expect(aplQuery.startsWith("['orbmeet'] |")).toBe(true);
      // A node's fields may not exist in the dataset yet; Axiom refuses a query naming one.
      expect(aplQuery).not.toMatch(/\b(level|service)\s*==/);
    }
  });

  it("ends each threshold query in the summary Axiom compares", () => {
    const thresholds = MONITORS.filter((monitor) => monitor.type === "Threshold");
    for (const { aplQuery } of thresholds) expect(aplQuery).toMatch(/\| summarize [^|]+$/);
  });
});

describe("the error monitor", () => {
  it("alerts on every level ship-logs.jq keeps a node's line at as an error", () => {
    // Two definitions of one list: a level only ship-logs.jq knows reaches
    // Axiom and alerts nobody (a LiveKit `fatal`, its last line).
    const jq = readFileSync(join(NODE_DIR, "ship-logs.jq"), "utf8");
    const failing = /def failing: IN\(([^)]*)\);/.exec(jq)?.[1].split(",").map((level) => JSON.parse(level.trim()));
    expect(failing && [...failing].sort()).toEqual([...NODE_ERROR_LEVELS].sort());
    const error = MONITORS.find((monitor) => monitor.name === "Orb Meet: error")!;
    for (const level of NODE_ERROR_LEVELS) expect(error.aplQuery).toContain(`"${level}"`);
  });
});
