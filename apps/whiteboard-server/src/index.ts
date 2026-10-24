import { loadWhiteboardServerConfig } from "./http/config.ts";
import { WhiteboardSyncApp } from "./app/sync-app.ts";

// The process entrypoint: load configuration from the environment, build the
// application, and listen. All policy, routing, and lifecycle decisions live
// in `src/app`; this file is the only place that touches the process itself.
const app = new WhiteboardSyncApp(loadWhiteboardServerConfig());

await app.start();
await app.listen();

process.on("SIGTERM", () => void app.shutdown("SIGTERM"));
process.on("SIGINT", () => void app.shutdown("SIGINT"));
