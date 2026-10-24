import { execFile, spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { promisify } from "node:util";
import type { BoardContainer } from "../src/board";

const run = promisify(execFile);

export const IMAGE = process.env.CODE_RUNNER_IMAGE ?? "orbmeet-code-runner:dev";

/**
 * Whether Docker is up and the toolchain image exists. `pnpm test:image`
 * rebuilds it first, so the suite never runs against a stale image.
 */
export async function containerImageAvailable(): Promise<boolean> {
  try {
    await run("docker", ["image", "inspect", IMAGE]);
    return true;
  } catch {
    return false;
  }
}

export async function startContainer(env: Record<string, string> = {}, flags: string[] = []): Promise<string> {
  // Production-shaped on the axes that decide what the tests mean:
  //
  //  - The image's own entrypoint runs (tini, then sleep), exactly as the
  //    container API starts it.
  //  - A real network stack, *not* `--network none`. `enableInternet: false`
  //    blocks egress at Cloudflare's edge, which Docker cannot reproduce and
  //    which is not the boundary under test here anyway; the boundary is the
  //    jail, so the container keeps loopback and egress and the jail is what has
  //    to deny them.
  //
  // The cpu/memory caps mirror the standard-1 instance the Worker asks for, so
  // timings here mean something about production.
  const { stdout } = await run("docker", [
    "run",
    "-d",
    "--rm",
    "--platform",
    "linux/amd64",
    "--cpus",
    "0.5",
    "--memory",
    "4g",
    // No swap, as on the instance: a run that exhausts memory is killed, not paged.
    "--memory-swap",
    "4g",
    ...Object.entries(env).flatMap(([name, value]) => ["-e", `${name}=${value}`]),
    ...flags,
    IMAGE,
  ]);
  return stdout.trim();
}

/**
 * Starts a root-owned TCP listener on the container's loopback, outside any
 * jail. It is the positive control for the loopback test: a snippet that cannot
 * reach it was blocked by the jail, not by there being nothing to reach.
 */
export async function startLoopbackListener(id: string, port: number): Promise<void> {
  await run("docker", [
    "exec",
    "-d",
    id,
    "python3",
    "-m",
    "http.server",
    "--bind",
    "127.0.0.1",
    String(port),
  ]);
}

/** Whether a root process outside the jail can open a connection to `port`. */
export async function loopbackReachableFromRoot(id: string, port: number): Promise<boolean> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const status = await run("docker", [
      "exec",
      id,
      "curl",
      "-s",
      "-o",
      "/dev/null",
      "-w",
      "%{http_code}",
      "-m",
      "5",
      `http://127.0.0.1:${port}/`,
    ]).then(({ stdout }) => stdout.trim(), (error: { stdout?: string }) => error.stdout?.trim() ?? "");
    if (/^\d{3}$/.test(status) && status !== "000") return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

export async function stopContainer(id: string): Promise<void> {
  await run("docker", ["kill", id]).catch(() => {});
}

export async function listCells(id: string): Promise<string> {
  const { stdout } = await run("docker", ["exec", id, "ls", "-A", "/cells"]);
  return stdout.trim();
}

/** Every live process in the container running as one of the slot users. */
export async function slotProcesses(id: string): Promise<string> {
  const { stdout } = await run("docker", [
    "exec",
    id,
    "/bin/sh",
    "-c",
    [
      "for p in /proc/[0-9]*; do",
      "  u=$(stat -c %u \"$p\" 2>/dev/null) || continue",
      "  s=$(awk '/^State:/ {print $2}' \"$p/status\" 2>/dev/null)",
      "  [ \"$u\" -ge 2000 ] && [ \"$u\" -lt 2100 ] && [ \"$s\" != Z ] && cat \"$p/comm\"",
      "done; true",
    ].join("\n"),
  ]);
  return stdout.trim();
}

/** Runs a command as root in the container, outside any slot. */
export async function rootExec(id: string, command: string[]): Promise<string> {
  const { stdout } = await run("docker", ["exec", id, ...command]);
  return stdout.trim();
}

/**
 * The container API's `exec()`, emulated with `docker exec`.
 *
 * What it has to get right is what production relies on: `pid` is the pid
 * inside the container, `kill(signal)` delivers that signal to it, and the
 * streams are byte streams. A one-line preamble on stderr carries the pid out
 * (the shell prints its own pid, then `exec`s the command in place, so they are
 * the same process) and is stripped before anyone reads stderr.
 */
export function dockerExec(containerId: string): Pick<Container, "exec"> {
  return {
    async exec(command, options = {}) {
      const flags = ["exec"];
      if (options.stdin !== undefined) flags.push("-i");
      if (options.user !== undefined) flags.push("-u", options.user);
      if (options.cwd !== undefined) flags.push("-w", options.cwd);
      for (const [name, value] of Object.entries(options.env ?? {})) flags.push("-e", `${name}=${value}`);
      const child = spawn("docker", [
        ...flags,
        containerId,
        "/bin/sh",
        "-c",
        'printf "%s\\n" "$$" >&2; exec "$@"',
        "sh",
        ...command,
      ]);

      const exitCode = new Promise<number>((resolve) => {
        child.on("close", (code, signal) => resolve(code ?? (signal ? 128 : 1)));
      });
      const pid = await new Promise<number>((resolve, reject) => {
        let preamble = new Uint8Array(0);
        const onData = (chunk: Uint8Array) => {
          const joined = new Uint8Array(preamble.length + chunk.length);
          joined.set(preamble);
          joined.set(chunk, preamble.length);
          preamble = joined;
          const newline = preamble.indexOf(0x0a);
          if (newline < 0) return;
          child.stderr.off("data", onData);
          child.stderr.pause();
          const rest = preamble.subarray(newline + 1);
          if (rest.length > 0) child.stderr.unshift(rest);
          resolve(Number(new TextDecoder().decode(preamble.subarray(0, newline))));
        };
        child.stderr.on("data", onData);
        child.on("error", reject);
        child.on("close", () => reject(new Error(`docker exec ended before starting: ${new TextDecoder().decode(preamble)}`)));
      });

      const kill = (signal = 15) => {
        // The shell's builtin: the image has no `kill` binary (that is procps).
        execFile("docker", ["exec", containerId, "/bin/sh", "-c", 'kill -s "$1" "$2"', "kill", String(signal), String(pid)], () => {});
      };
      options.signal?.addEventListener("abort", () => kill(9), { once: true });

      const stdout = options.stdout === "ignore"
        ? (child.stdout.resume(), null)
        : (Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>);
      const stderr = options.stderr === "ignore"
        ? (child.stderr.resume(), null)
        : (Readable.toWeb(child.stderr) as ReadableStream<Uint8Array>);
      const stdin = options.stdin === "pipe" ? (Writable.toWeb(child.stdin) as WritableStream) : null;
      if (options.stdin instanceof ReadableStream) {
        void options.stdin.pipeTo(Writable.toWeb(child.stdin) as WritableStream).catch(() => {});
      } else if (options.stdin === undefined) {
        child.stdin.end();
      }

      return {
        pid,
        isPty: false,
        stdin,
        stdout,
        stderr,
        exitCode,
        output: async () => {
          throw new Error("output() is not used by the runner");
        },
        kill,
        resize: () => {},
      } satisfies ExecProcess;
    },
  };
}

/**
 * The container API over a Docker container that is already running: the
 * board's own `Board` drives it unchanged. `destroyed` records any decision to
 * replace the container, which a healthy image should never provoke.
 */
export function dockerContainer(containerId: string): BoardContainer & { destroyed: string[] } {
  const destroyed: string[] = [];
  return {
    destroyed,
    get running() {
      return true;
    },
    start() {},
    async setInactivityTimeout() {},
    async destroy(reason?: unknown) {
      destroyed.push(String(reason));
    },
    exec: dockerExec(containerId).exec,
  };
}
