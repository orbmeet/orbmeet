import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../../..");
const configPath = resolve(root, "infra/dev/livekit.dev.yaml");
const CONTAINER = "livekit-dev";
const IMAGE = "livekit/livekit-server:v1.13.6";

// The signalling port lives in the config alone, so the two cannot disagree.
// It is never a media node's: this machine may run one (see the config).
const config = readFileSync(configPath, "utf8");
const port = Number(/^port:\s*(\d+)\s*$/m.exec(config)?.[1]);
if (!Number.isInteger(port)) throw new Error(`[livekit] No top-level port in ${configPath}`);

function answers() {
  return new Promise((res) => {
    const req = http.get(`http://127.0.0.1:${port}`, { timeout: 1000 }, (response) => {
      res(response.statusCode === 200);
    });
    req.on("error", () => res(false));
    req.on("timeout", () => {
      req.destroy();
      res(false);
    });
  });
}

/** Our own container's state: identified by name, never by whatever holds a port. */
function containerState() {
  const inspect = spawnSync(
    "docker",
    ["inspect", "--format", "{{.State.Running}} {{index .Config.Labels \"orbmeet.config\"}}", CONTAINER],
    { encoding: "utf8" },
  );
  if (inspect.status !== 0) return null;
  const [running, label] = inspect.stdout.trim().split(" ");
  return { running: running === "true", configHash: label };
}

function hasDocker() {
  return spawnSync("docker", ["--version"], { stdio: "ignore" }).status === 0;
}

// A config edit replaces the container instead of reusing a stale one.
const configHash = createHash("sha256").update(config).digest("hex").slice(0, 16);

if (!hasDocker()) {
  console.warn("[livekit] Docker is not available. Skipping automatic LiveKit start.");
} else {
  const state = containerState();
  if (state?.running && state.configHash === configHash && await answers()) {
    console.log(`[livekit] Development LiveKit is already running on 127.0.0.1:${port}.`);
  } else {
    console.log("[livekit] Starting the development LiveKit...");
    spawnSync("docker", ["rm", "-f", CONTAINER], { stdio: "ignore" });
    const run = spawnSync(
      "docker",
      [
        "run",
        "-d",
        "--name",
        CONTAINER,
        "--label",
        `orbmeet.config=${configHash}`,
        // Host networking lets its webhook reach the Vite dev server on
        // loopback; the config keeps every listener off media-node ports.
        "--network",
        "host",
        "-v",
        `${configPath}:/etc/livekit.yaml:ro`,
        IMAGE,
        "--config",
        "/etc/livekit.yaml",
      ],
      { stdio: "pipe", encoding: "utf8" },
    );

    if (run.status !== 0) {
      console.warn(`[livekit] Failed to start LiveKit container: ${run.stderr}`);
    } else {
      let ready = false;
      for (let attempt = 0; attempt < 10 && !ready; attempt++) {
        await new Promise((resolveTimeout) => setTimeout(resolveTimeout, 500));
        ready = await answers();
      }
      console[ready ? "log" : "warn"](
        ready
          ? `[livekit] Development LiveKit ready on 127.0.0.1:${port}.`
          : `[livekit] Container started but port ${port} did not become ready in time.`,
      );
    }
  }
}

if (!existsSync(resolve(root, "apps/web/.dev.vars"))) {
  console.warn(`[livekit] apps/web/.dev.vars is missing; its NODES should name ws://localhost:${port}.`);
}
