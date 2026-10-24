// Browser smoke tests over the whole local stack: the Worker under `vite dev
// --mode e2e`, the whiteboard server and a LiveKit. Run them with `pnpm e2e`,
// which prepares the stack first (e2e/run.ts).
import { defineConfig, devices } from "@playwright/test";
import {
  LIVEKIT_CONTAINER,
  LIVEKIT_IMAGE,
  LIVEKIT_PORT,
  WEB_DIR,
  WEB_PORT,
  WEB_URL,
  WHITEBOARD_PORT,
} from "./e2e/stack.ts";

export default defineConfig({
  testDir: "e2e",
  // One worker: each test already drives two or more browsers against one
  // stack, and the suite may share a machine with live meetings.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  outputDir: ".cloudflare/e2e-run/results",
  use: {
    baseURL: WEB_URL,
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
    permissions: ["camera", "microphone"],
    launchOptions: {
      args: [
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
        // The test LiveKit offers only loopback candidates, which Chrome
        // leaves out of ICE unless told otherwise.
        "--allow-loopback-in-peer-connection",
      ],
    },
  },
  webServer: [
    {
      name: "livekit",
      // e2e/run.ts removes the container before and after a run.
      command:
        `exec docker run --rm --name ${LIVEKIT_CONTAINER} --network host --cpus 1 ` +
        `-v ${WEB_DIR}e2e/livekit.yaml:/etc/livekit.yaml:ro ${LIVEKIT_IMAGE} --config /etc/livekit.yaml`,
      url: `http://127.0.0.1:${LIVEKIT_PORT}`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      name: "whiteboard",
      command: "node e2e/whiteboard-supervisor.ts",
      cwd: WEB_DIR,
      url: `http://127.0.0.1:${WHITEBOARD_PORT}/health`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      name: "web",
      command: `pnpm exec vite dev --mode e2e --port ${WEB_PORT} --strictPort`,
      cwd: WEB_DIR,
      url: WEB_URL,
      reuseExistingServer: false,
      timeout: 180_000,
    },
  ],
});
