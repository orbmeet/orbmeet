// The smoke tests' LiveKit, run by Playwright as a web server: it lives as
// long as this process. e2e/run.ts removes the container on both sides of a
// run, since LiveKit drains its rooms on SIGTERM rather than exiting.
import { spawn } from "node:child_process";
import process from "node:process";
import { dockerNetworking, liveKitRunArgs } from "../scripts/lib/livekit-container.ts";
import { LIVEKIT_API_KEY, LIVEKIT_CONTAINER, LIVEKIT_KEYS, LIVEKIT_PORT, WEB_PORT } from "./stack.ts";

const networking = dockerNetworking();
if (!networking) {
  console.error("[e2e] Docker is not available, and the smoke tests run LiveKit in it.");
  process.exit(1);
}

const docker = spawn("docker", liveKitRunArgs({
  networking,
  name: LIVEKIT_CONTAINER,
  port: LIVEKIT_PORT,
  keys: LIVEKIT_KEYS,
  webhook: { apiKey: LIVEKIT_API_KEY, port: WEB_PORT },
  dockerOptions: ["--rm", "--cpus", "1"],
}), { stdio: "inherit" });

// `docker run` passes a signal on to the container.
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => docker.kill(signal));
docker.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
