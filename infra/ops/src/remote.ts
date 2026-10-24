import { tmpdir } from "node:os";
import { join } from "node:path";
import { DOCKERFILES, REMOTE, REMOTE_NODE_DIR, WORKSPACE_FILES } from "./catalog.ts";
import type { Inventory } from "./inventory.ts";
import { imageSources } from "./render.ts";
import type { RunOptions, Shell } from "./shell.ts";

// One connection per node, reused by every ssh and rsync of a run.
const SSH_OPTIONS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-o", "ControlMaster=auto",
  "-o", `ControlPath=${join(tmpdir(), "orbmeet-ssh-%C")}`, "-o", "ControlPersist=60"];

export function ssh(shell: Shell, inv: Inventory, name: string, command: string, options?: RunOptions): Promise<string> {
  return shell(["ssh", ...SSH_OPTIONS, inv.nodes[name].ssh, command], options);
}

const quote = (arg: string) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'"'"'`)}'`);

/** Run node/deploy.sh on the node, as root. */
export function deployScript(shell: Shell, inv: Inventory, name: string, args: readonly string[],
  options?: RunOptions): Promise<string> {
  return ssh(shell, inv, name, `sudo -n bash ${REMOTE_NODE_DIR}/deploy.sh ${args.map(quote).join(" ")}`, options);
}

/** The Compose services an apply would create, replace or remove. */
export async function plan(shell: Shell, inv: Inventory, name: string): Promise<string[]> {
  return (await deployScript(shell, inv, name, ["plan"], { capture: true })).split(/\s+/).filter(Boolean);
}

/**
 * Send the node what it builds from and runs: the workspace files, node/, the
 * sources of every image (so a service can move to any node), and its
 * rendered runtime files from <rendered>/<node>.
 */
export async function sync(shell: Shell, inv: Inventory, name: string, rendered: string, options?: RunOptions): Promise<void> {
  const target = inv.nodes[name].ssh;
  await ssh(shell, inv, name, `sudo -n mkdir -p ${REMOTE_NODE_DIR}/.runtime`, options);
  const rsync = ["rsync", "-az", "--rsync-path=sudo -n rsync", "--chown=root:root", "-e", `ssh ${SSH_OPTIONS.join(" ")}`,
    "--exclude=node_modules", "--exclude=.env*", "--exclude=.dev.vars*", "--exclude=dist", "--exclude=*.test.ts",
    "--exclude=*.spec.ts", "--exclude=.DS_Store"];
  // An explicit allowlist: no docs, .git, operator code, secrets or unrelated applications.
  const sources = [...new Set(Object.keys(DOCKERFILES).flatMap((s) => imageSources(s as keyof typeof DOCKERFILES)))];
  const paths = [...WORKSPACE_FILES, "infra/ops/node", ...sources];
  await shell([...rsync, "--delete", "--delete-excluded", "--filter=P .runtime/***", "--exclude=.runtime", "--relative",
    ...paths.map((p) => `./${p}`), `${target}:${REMOTE}/`], options);
  await shell([...rsync, "--delete", `${join(rendered, name)}/`, `${target}:${REMOTE_NODE_DIR}/.runtime/`], options);
}

/** Whether the node runs a Compose service now; a node without Docker yet runs nothing, and one that cannot be reached fails. */
export async function runs(shell: Shell, inv: Inventory, name: string, service: string): Promise<boolean> {
  return (await ssh(shell, inv, name, "command -v docker >/dev/null || exit 0; "
    + `sudo -n docker ps -q --filter label=com.docker.compose.project=orbmeet-${name} `
    + `--filter label=com.docker.compose.service=${service}`, { capture: true })).trim() !== "";
}
