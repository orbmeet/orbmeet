import { fileURLToPath } from "node:url";
import { JobType } from "@livekit/protocol";
import { cli, ServerOptions, WorkerPermissions } from "@livekit/agents";
import { configureLiveKitEnvironment, loadAgentConfig } from "./config.js";
import { TranscriptJournal } from "./outbox/transcript-journal.js";
import { deliverTranscriptPayload, runTranscriptShipper } from "./outbox/transcript-shipper.js";
import { logError } from "./log.js";

const config = loadAgentConfig();
configureLiveKitEnvironment(config);

// The parent process outlives individual publisher jobs. It ships the journal
// they share to the app, including rows an earlier process left behind, and
// keeps shipping while a SIGTERM drains the jobs. Whatever it has not shipped
// when the process exits stays journaled for the next one; a request cut off
// mid-flight is replayed, and the app ignores a segment it already has.
const journal = new TranscriptJournal(config.transcriptJournalPath);
void runTranscriptShipper(
  journal,
  (payload) => deliverTranscriptPayload(config, payload),
  { maxUnresolvedAgeMs: config.maxUnresolvedAgeMs, signal: new AbortController().signal },
).catch((error: unknown) => logError("Transcript shipper stopped unexpectedly", error));

cli.runApp(new ServerOptions({
  agent: fileURLToPath(new URL("./agent/agent.js", import.meta.url)),
  // Automatic publisher dispatch is intentional: Orb Meet produces a durable
  // transcript whenever a participant publishes microphone audio. The in-room
  // captions control only changes local overlay visibility.
  agentName: "",
  serverType: JobType.JT_PUBLISHER,
  // Caption workers are infrastructure, not meeting attendees. They need only
  // microphone subscription and data publication, and must never appear in the
  // participant grid or count.
  permissions: new WorkerPermissions(false, true, true, false, [], true),
  // Each media node runs one agent beside its LiveKit (infra/ops), which must
  // reject work before CPU saturation makes every stream unhealthy. More
  // agents could register with the same empty name; LiveKit would share
  // publisher jobs between them.
  loadFunc: async (worker) => worker.activeJobs.length / config.maxActiveJobs,
  loadThreshold: 1,
  numIdleProcesses: Math.min(2, config.maxActiveJobs),
  shutdownProcessTimeout: 45_000,
  requestFunc: async (request) => {
    await request.accept("Orb Meet captions");
  },
  // Docker probes this from inside the container. Nothing on the bridge or host
  // needs the agent SDK's diagnostic HTTP surface.
  host: "127.0.0.1",
  port: 8_081,
}));
