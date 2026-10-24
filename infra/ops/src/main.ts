import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { LOCAL, OPS } from "./catalog.ts";
import { check } from "./check.ts";
import { deploy, type Context } from "./deploy.ts";
import { loadInventory } from "./inventory.ts";
import { activity } from "./livekit.ts";
import { applyMonitors, axiomApi } from "./monitors.ts";
import { writePrivate } from "./render.ts";
import { ageStore, fillSecrets, loadSecrets, setSecret, validateSecrets, type Secrets } from "./secrets.ts";
import { OpsError, shell } from "./shell.ts";

const USAGE = `Set up, deploy, inspect or verify Orb Meet's self-hosted nodes.

  pnpm ops deploy [node]       the nodes, the whiteboard among them: from a new VM's first Docker install to a changed
                               firewall rule (and the Worker secrets they need)
  pnpm ops check               every node's readiness, and what clients see of each
  pnpm ops set-secret NAME     import a secret created elsewhere (value read from stdin)
  pnpm ops edit-secrets        open the decrypted secrets in $EDITOR, as for a key rotation
  pnpm ops monitors            make the account's Axiom monitors the ones in src/monitors.ts
                               (AXIOM_API_TOKEN: a token that may manage monitors)

Options:
  --yes            deploy: restart media services at once, even under live rooms, rather
                   than drain the node (no new Meetings) and wait for its rooms to end
  --external-only  check: skip the readiness checks over SSH

Every node is independent: its media stack (LiveKit, TURN, Redis, Egress, the
transcription agent) and any other service it runs share nothing with other
nodes. The Cloudflare Worker places each Meeting on a media node from
NODES, which every deploy publishes from inventory.json, and probes each
node's services itself.`;

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    const prompt = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    try {
      return await prompt.question("Value (it is echoed; paste and press enter): ");
    } finally {
      prompt.close();
    }
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
}

/**
 * A directory for decrypted files that lives in memory where the OS offers it
 * (Linux's /dev/shm), so secrets never reach the operator's disk. Removed on
 * exit, including Ctrl-C.
 */
function privateDir(): string {
  const dir = mkdtempSync(join(existsSync("/dev/shm") ? "/dev/shm" : tmpdir(), "orbmeet-ops-"));
  const remove = () => rmSync(dir, { recursive: true, force: true });
  process.once("exit", remove);
  process.once("SIGINT", () => {
    remove();
    process.exit(130);
  });
  return dir;
}

/** Decrypt into a private file, edit, then validate and re-encrypt. */
async function editSecrets(store: ReturnType<typeof ageStore>, inv: ReturnType<typeof loadInventory>): Promise<void> {
  const file = join(privateDir(), "secrets.json");
  writePrivate(file, `${JSON.stringify(await store.read() ?? { nodes: {} }, null, 2)}\n`);
  const editor = process.env.VISUAL ?? process.env.EDITOR ?? "vi";
  const result = spawnSync("sh", ["-c", `${editor} "$1"`, "editor", file], { stdio: "inherit" });
  if (result.status !== 0) throw new OpsError("The editor failed; nothing was saved");
  let edited: Secrets;
  try {
    edited = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new OpsError("The edited secrets are not JSON; nothing was saved");
  }
  const { secrets } = fillSecrets(inv, edited);
  await store.write(validateSecrets(secrets));
  console.log("Saved secrets.age (values not printed).");
}

async function main(): Promise<void> {
  process.umask(0o077);
  const { values: options, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      yes: { type: "boolean", default: false },
      "external-only": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [action, target, ...extra] = positionals;
  const actions = ["deploy", "check", "set-secret", "edit-secrets", "monitors"];
  if (options.help || !action || !actions.includes(action) || extra.length) {
    console.log(USAGE);
    process.exitCode = options.help ? 0 : 2;
    return;
  }
  if (options.yes && action !== "deploy") throw new OpsError("--yes is only valid with deploy");
  if (options["external-only"] && action !== "check") throw new OpsError("--external-only is only valid with check");

  if (action === "monitors") {
    if (target) throw new OpsError("monitors takes no argument");
    await applyMonitors(axiomApi(), (line) => console.log(`[monitors] ${line}`));
    return;
  }

  const inv = loadInventory(JSON.parse(readFileSync(join(OPS, "inventory.json"), "utf8")));
  const store = ageStore(shell);
  if (action === "set-secret") {
    if (!target) throw new OpsError("set-secret needs the secret's name");
    // Read from stdin, never argv: no shell history, no process listing.
    await setSecret(inv, store, target, await readStdin());
    console.log(`[set-secret] ${target} updated (value not printed)`);
    return;
  }
  if (action === "edit-secrets") {
    if (target) throw new OpsError("edit-secrets takes no argument");
    await editSecrets(store, inv);
    return;
  }
  if (target !== undefined && !(target in inv.nodes)) {
    throw new OpsError(`Unknown node ${JSON.stringify(target)}; inventory has ${Object.keys(inv.nodes).join(", ")}`);
  }
  if (action === "check" && target) throw new OpsError("check does not accept a node");
  const names = target ? [target] : Object.keys(inv.nodes);
  const secrets = await loadSecrets(inv, store);
  const ctx: Context = {
    inv, secrets, shell, local: LOCAL, work: privateDir(), assumeYes: options.yes,
    activity: (name) => activity(inv, secrets, name),
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: (line) => console.log(line),
  };
  switch (action) {
    case "deploy": return deploy(ctx, names);
    case "check": return check(shell, inv, secrets, { externalOnly: options["external-only"] });
  }
}

main().catch((error: unknown) => {
  // Our own failures, and the network's, are one line; anything else keeps its stack.
  if (error instanceof OpsError || (error instanceof Error && ("code" in error || error.name === "TwirpError"))) {
    console.error(`FAIL: ${error.message}`);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
});
