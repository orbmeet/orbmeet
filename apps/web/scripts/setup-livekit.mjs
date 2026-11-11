// Starts `pnpm dev`'s LiveKit, or keeps the one already running when it is
// this configuration's. The smoke tests run their own (e2e/livekit.ts), on
// other ports, so the two can run side by side.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import http from "node:http";
import { resolve } from "node:path";
import { dockerNetworking, liveKitRunArgs } from "./lib/livekit-container.ts";

const root = resolve(import.meta.dirname, "../../..");
const CONTAINER = "livekit-dev";
const PORT = 27880;
/** The Vite dev server, as scripts/web.mjs starts it. */
const WEB_PORT = 3000;
// apps/web/.dev.vars.example's NODES and the transcription agent's
// .env.example name the same key.
const KEYS = { devkey: "secret" };

function answers() {
  return new Promise((res) => {
    const req = http.get(`http://127.0.0.1:${PORT}`, { timeout: 1000 }, (response) => {
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

const networking = dockerNetworking();

if (!networking) {
  console.warn("[livekit] Docker is not available. Skipping automatic LiveKit start.");
} else {
  const run = liveKitRunArgs({ networking, name: CONTAINER, port: PORT, keys: KEYS, webhook: { apiKey: "devkey", port: WEB_PORT } });
  // Any change to what would run (image, configuration, networking) replaces
  // the container instead of reusing a stale one.
  const configHash = createHash("sha256").update(JSON.stringify(run)).digest("hex").slice(0, 16);
  const state = containerState();
  if (state?.running && state.configHash === configHash && await answers()) {
    console.log(`[livekit] Development LiveKit is already running on 127.0.0.1:${PORT}.`);
  } else {
    console.log(`[livekit] Starting the development LiveKit (${networking === "host" ? "host networking" : "ports published on 127.0.0.1"})...`);
    spawnSync("docker", ["rm", "-f", CONTAINER], { stdio: "ignore" });
    const [command, ...rest] = run;
    const started = spawnSync(
      "docker",
      [command, "-d", "--label", `orbmeet.config=${configHash}`, ...rest],
      { stdio: "pipe", encoding: "utf8" },
    );

    if (started.status !== 0) {
      console.warn(`[livekit] Failed to start LiveKit container: ${started.stderr}`);
    } else {
      let ready = false;
      for (let attempt = 0; attempt < 10 && !ready; attempt++) {
        await new Promise((resolveTimeout) => setTimeout(resolveTimeout, 500));
        ready = await answers();
      }
      console[ready ? "log" : "warn"](
        ready
          ? `[livekit] Development LiveKit ready on 127.0.0.1:${PORT}.`
          : `[livekit] Container started but port ${PORT} did not become ready in time; see \`docker logs ${CONTAINER}\`.`,
      );
    }
  }
}

if (!existsSync(resolve(root, "apps/web/.dev.vars"))) {
  console.warn(`[livekit] apps/web/.dev.vars is missing; its NODES should name ws://localhost:${PORT}.`);
}
