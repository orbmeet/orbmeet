import { join } from "node:path";
import { DOCKERFILES, REMOTE, REMOTE_NODE_DIR, WORKSPACE_FILES } from "./catalog.ts";
import type { Inventory } from "./inventory.ts";
import { imageSources } from "./render.ts";
import { OpsError, type RunOptions, type Shell } from "./shell.ts";

// One connection per node, reused by every ssh and rsync of a run. The socket
// lives in ~/.ssh, not the system temp directory: macOS's is long enough to
// push the path past the 104-byte limit on Unix socket names.
const SSH_OPTIONS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-o", "ControlMaster=auto",
  "-o", "ControlPath=~/.ssh/orbmeet-%C", "-o", "ControlPersist=60"];

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
 * Fail unless the local `rsync` is rsync itself. macOS ships openrsync as
 * `rsync` (Sequoia and later), and openrsync accepts every flag `sync` passes
 * yet honours two of them differently: with `--relative` its `--delete`
 * removes nothing, so files deleted from the repo stay on the node and in its
 * build context; without `--relative` it ignores `--filter=P` and deletes the
 * node's `.runtime/`. Neither failure says so, hence the check up front.
 */
export async function requireRsync(shell: Shell): Promise<void> {
  const version = await shell(["rsync", "--version"], { capture: true });
  if (/^rsync\s+version\s/.test(version)) return;
  throw new OpsError(`The rsync on PATH is not rsync (it reports "${version.split("\n")[0].trim()}"). `
    + "Install it (macOS: `brew install rsync`) and put it ahead of /usr/bin on PATH.");
}

/**
 * Send the node what it builds from and runs: the workspace files, node/, the
 * sources of every image (so a service can move to any node), and its
 * rendered runtime files from <rendered>/<node>.
 */
export async function sync(shell: Shell, inv: Inventory, name: string, rendered: string, options?: RunOptions): Promise<void> {
  await requireRsync(shell);
  const target = inv.nodes[name].ssh;
  await ssh(shell, inv, name, `sudo -n mkdir -p ${REMOTE_NODE_DIR}/.runtime`, options);
  // `-a` less owner and group (`-o -g`): the receiving rsync runs as root, so
  // what it creates is root's, without carrying this machine's user ids over.
  const rsync = ["rsync", "-rlptDz", "--rsync-path=sudo -n rsync", "-e", `ssh ${SSH_OPTIONS.join(" ")}`,
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
