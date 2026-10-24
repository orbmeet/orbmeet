import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, SERVICES } from "./catalog.ts";
import type { Inventory } from "./inventory.ts";
import type { Activity } from "./livekit.ts";
import { deployScript, plan, runs, sync } from "./remote.ts";
import { nodesSecret, prepare, writePrivate } from "./render.ts";
import { AI_KEY, transcriptionKeysSecret, type Secrets } from "./secrets.ts";
import { OpsError, type Shell } from "./shell.ts";

export interface Context {
  inv: Inventory;
  secrets: Secrets;
  shell: Shell;
  /** Operator-local cache: the publish stamp, never a secret. */
  local: string;
  /** A private directory for this run's decrypted files, removed when it ends. */
  work: string;
  /** Restart media under live rooms at once, rather than drain the node first. */
  assumeYes: boolean;
  activity(name: string): Promise<Activity>;
  /** Resolves after `ms`; a test passes one that does not wait. */
  wait(ms: number): Promise<void>;
  log(line: string): void;
}

/** How often a drain asks the node's LiveKit whether its rooms have ended. */
const DRAIN_POLL_MS = 30_000;

/**
 * Install the Worker's secrets for the nodes, when they changed. `drained`
 * names a node published at weight 0: it keeps its Meetings, takes no new ones.
 */
export async function publish(ctx: Context, drained?: string): Promise<void> {
  const { inv, secrets: c } = ctx;
  const values: Record<string, string> = {
    NODES: nodesSecret(inv, c, drained),
    TRANSCRIPTION_INTERNAL_KEYS: transcriptionKeysSecret(inv, c),
    // Meeting summaries share the one key the whiteboard assistant uses.
    ...(c[AI_KEY] ? { [AI_KEY]: c[AI_KEY] } : {}),
  };
  // `cf workers secrets bulk` is the API's RFC 7396 endpoint: each update is a
  // complete secret binding under the top-level `secrets` member, and omitted
  // remote secrets remain unchanged.
  const bundle = JSON.stringify({
    secrets: Object.fromEntries(Object.keys(values).sort()
      .map((name) => [name, { name, text: values[name], type: "secret_text" }])),
  });
  const published = createHash("sha256").update(bundle).digest("hex");
  const stamp = join(ctx.local, "published.sha256");
  if (existsSync(stamp) && readFileSync(stamp, "utf8").trim() === published) return;
  ctx.log("[publish] Worker secrets");
  const path = join(ctx.work, "worker-secrets.json");
  writePrivate(path, bundle);
  await ctx.shell(["pnpm", "exec", "cf", "workers", "secrets", "bulk", "--worker", "orbmeet", "--file", path],
    { cwd: join(ROOT, "apps/web") });
  writePrivate(stamp, `${published}\n`);
}

/**
 * Bring every node's source, runtime files and images up to this checkout, in
 * parallel. Nothing that runs changes: a node whose build fails stops the
 * deploy before any node, Worker or database does.
 */
async function buildNodes(ctx: Context, names: readonly string[]): Promise<void> {
  const rendered = join(ctx.work, "nodes");
  prepare(ctx.inv, ctx.secrets, rendered);
  await Promise.all(names.map(async (name) => {
    const started = Date.now();
    ctx.log(`[build] ${name}`);
    await sync(ctx.shell, ctx.inv, name, rendered, { quiet: true });
    await deployScript(ctx.shell, ctx.inv, name, ["build"], { quiet: true });
    ctx.log(`[build] ${name} ready in ${Math.round((Date.now() - started) / 1000)}s`);
  }));
}

/** What a restart of the node's media would interrupt now. */
async function liveOn(ctx: Context, name: string): Promise<Activity> {
  try {
    return await ctx.activity(name);
  } catch (error) {
    throw new OpsError(`Could not ask ${name}'s LiveKit what a restart would interrupt `
      + `(${(error as Error).message}); rerun with --yes to restart it regardless`);
  }
}

const busy = (live: Activity) => live.rooms > 0 || live.recording;

function describe(live: Activity): string {
  return `${live.rooms} live room${live.rooms === 1 ? "" : "s"}${live.recording ? " and a recording" : ""}`;
}

/**
 * Converge one built node. Restarting its media would end its rooms (and lose
 * a recording in progress), so a node with live rooms is drained first: it
 * takes no new Meetings while the ones it has run to their end, and is
 * restarted once none is left. `--yes` restarts it at once instead. The
 * whiteboard restarts without waiting: its clients reconnect and lose nothing.
 */
async function applyNode(ctx: Context, name: string): Promise<void> {
  const { inv, shell } = ctx;
  const changed = await plan(shell, inv, name);
  const media = changed.filter((service) => (SERVICES.media as readonly string[]).includes(service));
  if (media.length && !ctx.assumeYes && await runs(shell, inv, name, "livekit")) {
    let live = await liveOn(ctx, name);
    if (busy(live)) {
      // Drained, a node that alone takes Meetings would still be given every new one.
      const others = Object.entries(inv.nodes).filter(([other, node]) =>
        other !== name && node.services.includes("media") && node.weight > 0);
      if (others.length === 0) {
        throw new OpsError(`${name} is the only media node taking Meetings, so it cannot be drained; `
          + `rerun with --yes to restart its ${describe(live)} now`);
      }
      await publish(ctx, name);
      try {
        ctx.log(`[drain] ${name}: replacing ${media.join(", ")}; no new Meetings go to it, and it restarts once its `
          + `${describe(live)} end. Ctrl-C stops waiting (the next deploy gives it Meetings again); --yes restarts now.`);
        while (busy(live)) {
          await ctx.wait(DRAIN_POLL_MS);
          const next = await liveOn(ctx, name);
          if (describe(next) !== describe(live)) ctx.log(`[drain] ${name}: ${describe(next)} left`);
          live = next;
        }
        ctx.log(`[apply] ${name}: ${changed.join(", ")}`);
        await deployScript(shell, inv, name, ["apply"]);
      } finally {
        await publish(ctx);
      }
      return;
    }
  }
  ctx.log(`[apply] ${name}: ${changed.join(", ") || "no changes"}`);
  await deployScript(shell, inv, name, ["apply"]);
}

/** One node at a time, so a refused apply leaves later nodes untouched. */
async function applyNodes(ctx: Context, names: readonly string[]): Promise<void> {
  for (const name of names) await applyNode(ctx, name);
}

/**
 * Deploy the nodes: everything about each host and its services, from a new
 * VM's first Docker install to a changed firewall rule.
 */
export async function deploy(ctx: Context, names: readonly string[]): Promise<void> {
  // The checkout every node is built from passes the gate CI holds a change
  // to (see .github/workflows/check.yml) before anything leaves this machine.
  ctx.log("[deploy] pnpm check");
  await ctx.shell(["pnpm", "check"], { cwd: ROOT });
  await buildNodes(ctx, names);
  // The Worker learns of new nodes and keys before any node uses them. It
  // places Meetings only on nodes its probe has reached, and a new key is
  // added second and promoted later, so publishing first is always safe.
  await publish(ctx);
  await applyNodes(ctx, names);
}
