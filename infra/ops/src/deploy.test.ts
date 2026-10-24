import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { ROOT } from "./catalog.ts";
import { deploy, publish, type Context } from "./deploy.ts";
import { loadInventory } from "./inventory.ts";
import type { Activity } from "./livekit.ts";
import { OpsError, type Shell } from "./shell.ts";
import { fakeSecrets, INVENTORY } from "./test-fixtures.ts";

/**
 * A fake node fleet behind a fake shell. Each step is recorded as one
 * readable line: "<node> sync", "<node> build", "<node> plan", "<node> apply",
 * "ask", or the local command run.
 */
function fleet() {
  const inv = loadInventory(INVENTORY);
  const state = {
    steps: [] as string[],
    plan: "",
    // "<service>" runs on every node, "<node>:<service>" on that node only.
    running: new Set(["livekit", "egress"]),
    live: { rooms: 0, recording: false } as Activity,
    // What LiveKit reports on each later ask, as rooms end; the last entry repeats.
    later: [] as Activity[],
    failBuild: null as string | null,
    failApply: false,
    uploads: [] as { args: readonly string[]; payload: { secrets: Record<string, { text: string }> } }[],
  };
  const nodeOf = (target: string) => Object.keys(inv.nodes).find((name) => target.endsWith(inv.nodes[name].ssh.split("@")[1]))!;
  const shell: Shell = async (args, options = {}) => {
    if (args[0] === "ssh") {
      const name = nodeOf(args.at(-2)!);
      const command = args.at(-1)!;
      const script = /deploy\.sh (build|plan|apply)(.*)$/.exec(command);
      if (script) {
        state.steps.push(`${name} ${script[1]}${script[2]}`);
        if (script[1] === "build" && state.failBuild === name) throw new OpsError(`${name}: build failed`);
        if (script[1] === "apply" && state.failApply) throw new OpsError(`${name}: apply failed`);
        return script[1] === "plan" ? state.plan : "";
      }
      const service = /com\.docker\.compose\.service=([a-z]+)$/.exec(command);
      if (service) return state.running.has(service[1]) || state.running.has(`${name}:${service[1]}`) ? "abc123\n" : "";
      return "";
    }
    if (args[0] === "rsync") {
      if (args.includes("--relative")) state.steps.push(`${nodeOf(args.at(-1)!.split(":")[0])} sync`);
      return "";
    }
    const cwd = (options.cwd ?? ROOT).slice(ROOT.length + 1);
    state.steps.push(`${cwd ? `${cwd}: ` : ""}${args.slice(0, 6).join(" ")}`);
    if (args.includes("bulk")) {
      state.uploads.push({ args, payload: JSON.parse(readFileSync(args[args.indexOf("--file") + 1], "utf8")) });
      const weights = JSON.parse(state.uploads.at(-1)!.payload.secrets.NODES.text) as Record<string, { weight: number }>;
      state.steps.push(`publish ${Object.entries(weights).map(([name, node]) => `${name}=${node.weight}`).join(" ")}`);
    }
    return "";
  };
  const local = mkdtempSync(join(tmpdir(), "ops-deploy-"));
  const ctx = (assumeYes = false): Context => ({
    inv, secrets: fakeSecrets(), shell, local, work: mkdtempSync(join(tmpdir(), "ops-work-")), assumeYes,
    activity: async () => state.live,
    wait: async () => {
      state.steps.push("wait");
      if (state.later.length > 0) state.live = state.later.length > 1 ? state.later.shift()! : state.later[0];
    },
    log: () => {},
  });
  // Node steps, waits, and every publish after the deploy's first.
  const nodeSteps = () => {
    const first = state.steps.findIndex((step) => step.startsWith("publish"));
    return state.steps.filter((step, index) =>
      /^(sg1|my1) (plan|apply)/.test(step) || step === "wait" || (step.startsWith("publish") && index !== first));
  };
  return { state, ctx, inv, nodeSteps };
}

describe("publish", () => {
  it("uploads the Worker's secrets as cf's bulk payload, once per change", async () => {
    const { state, ctx } = fleet();
    const context = ctx();
    await publish(context);
    await publish(context);
    expect(state.uploads).toHaveLength(1);
    const [{ args, payload }] = state.uploads;
    expect(args.slice(0, 8)).toEqual(["pnpm", "exec", "cf", "workers", "secrets", "bulk", "--worker", "orbmeet"]);
    expect(Object.keys(payload.secrets).sort()).toEqual(["NODES", "TRANSCRIPTION_INTERNAL_KEYS"]);
    // The Worker accepts transcripts from every media node's agent.
    const c = fakeSecrets();
    const keys = payload.secrets.TRANSCRIPTION_INTERNAL_KEYS;
    expect(JSON.parse(keys.text)).toEqual({
      "sg1-ingest": c.nodes.sg1.TRANSCRIPTION_INTERNAL_SECRET,
      "my1-ingest": c.nodes.my1.TRANSCRIPTION_INTERNAL_SECRET,
    });
    for (const [name, secret] of Object.entries(payload.secrets)) {
      expect(secret).toEqual({ name, type: "secret_text", text: expect.any(String) });
    }
    // The plaintext bundle is written only to the run's private directory.
    expect(args[args.indexOf("--file") + 1].startsWith(context.work)).toBe(true);
  });

  it("gives the Worker the one AI key once it is set", async () => {
    const { state, ctx } = fleet();
    const context = ctx();
    await publish({ ...context, secrets: { ...context.secrets, AI_API_KEY: "provider-key" } });
    expect(state.uploads[0].payload.secrets.AI_API_KEY).toEqual({ name: "AI_API_KEY", type: "secret_text", text: "provider-key" });
  });
});

describe("deploy", () => {
  let f: ReturnType<typeof fleet>;
  beforeEach(() => {
    f = fleet();
  });

  it("builds every node, then tells the Worker, then applies", async () => {
    await deploy(f.ctx(), ["sg1", "my1"]);
    const steps = f.state.steps;
    const lastBuild = Math.max(steps.indexOf("sg1 build"), steps.indexOf("my1 build"));
    const publish = steps.findIndex((step) => step.includes("secrets bulk"));
    expect(steps.indexOf("sg1 sync")).toBeLessThan(steps.indexOf("sg1 build"));
    expect(lastBuild).toBeLessThan(publish);
    expect(publish).toBeLessThan(steps.indexOf("my1 apply"));
  });

  it("holds the checkout to the repository's checks before touching any node", async () => {
    await deploy(f.ctx(), ["sg1"]);
    expect(f.state.steps[0]).toBe("pnpm check");
  });

  it("changes nothing anywhere when one node fails to build", async () => {
    f.state.failBuild = "sg1";
    await expect(deploy(f.ctx(), ["sg1", "my1"])).rejects.toThrow("sg1: build failed");
    expect(f.state.steps.some((step) => step.includes("apply") || step.includes("secrets bulk"))).toBe(false);
  });

  it("restarts media on an idle node without asking", async () => {
    f.state.plan = "livekit\negress\n";
    await deploy(f.ctx(), ["my1"]);
    expect(f.nodeSteps()).toEqual(["my1 plan", "my1 apply"]);
  });

  it("drains a node with live rooms, restarts it once they end, then gives it Meetings again", async () => {
    f.state.plan = "livekit\n";
    f.state.live = { rooms: 2, recording: false };
    f.state.later = [{ rooms: 1, recording: true }, { rooms: 0, recording: true }, { rooms: 0, recording: false }];
    await deploy(f.ctx(), ["my1"]);
    expect(f.nodeSteps()).toEqual([
      "my1 plan", "publish sg1=2 my1=0", "wait", "wait", "wait", "my1 apply", "publish sg1=2 my1=1",
    ]);
  });

  it("gives a drained node Meetings again even when its apply fails", async () => {
    f.state.plan = "transcription\n";
    f.state.live = { rooms: 1, recording: false };
    f.state.later = [{ rooms: 0, recording: false }];
    f.state.failApply = true;
    await expect(deploy(f.ctx(), ["my1"])).rejects.toThrow("my1: apply failed");
    expect(f.nodeSteps().at(-1)).toBe("publish sg1=2 my1=1");
  });

  it("never drains the only media node taking Meetings", async () => {
    f.inv.nodes.sg1.weight = 0;
    f.state.plan = "livekit\n";
    f.state.live = { rooms: 1, recording: false };
    await expect(deploy(f.ctx(), ["my1"])).rejects.toThrow("only media node taking Meetings");
    expect(f.nodeSteps()).toEqual(["my1 plan"]);
  });

  it("restarts live rooms at once with --yes", async () => {
    f.state.plan = "caddy\n";
    f.state.live = { rooms: 1, recording: false };
    await deploy(f.ctx(true), ["my1"]);
    expect(f.nodeSteps()).toEqual(["my1 plan", "my1 apply"]);
  });

  it("never drains for the whiteboard", async () => {
    f.state.plan = "whiteboard\n";
    f.state.live = { rooms: 5, recording: true };
    await deploy(f.ctx(), ["my1"]);
    expect(f.nodeSteps()).toEqual(["my1 plan", "my1 apply"]);
  });

  it("applies nodes in the order named, every one running its own whiteboard", async () => {
    f.state.running = new Set(["whiteboard"]);
    f.state.plan = "whiteboard\n";
    await deploy(f.ctx(), ["sg1", "my1"]);
    expect(f.nodeSteps().filter((step) => step.endsWith("apply"))).toEqual(["sg1 apply", "my1 apply"]);
  });
});
