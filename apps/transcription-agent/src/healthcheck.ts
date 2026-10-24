import { readFileSync, statSync } from "node:fs";
import { connect as tcpConnect } from "node:net";
import { connect } from "node:tls";
import { pathToFileURL } from "node:url";
import * as v from "valibot";
import {
  isUnhealthyTranscriptionConnection,
  readActiveTranscriptionConnectionStatuses,
} from "./outbox/transcription-health.js";
import { loadAgentConfig } from "./config.js";
import { TranscriptJournal } from "./outbox/transcript-journal.js";

const CA_BUNDLE = "/etc/ssl/certs/ca-certificates.crt";
const PROBE_TIMEOUT_MS = 5_000;
const workerHealthSchema = v.object({ worker_type: v.string() });

export interface TlsEndpoint {
  host: string;
  port: number;
}

export function getTlsEndpoint(value: string): TlsEndpoint {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "wss:") {
    throw new Error(`${url.protocol} is not a TLS endpoint`);
  }
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 443,
  };
}

async function probeTls(value: string): Promise<void> {
  const { host, port } = getTlsEndpoint(value);
  const ca = readFileSync(CA_BUNDLE);
  await new Promise<void>((resolve, reject) => {
    const socket = connect({
      host,
      port,
      servername: host,
      ca,
      rejectUnauthorized: true,
      timeout: PROBE_TIMEOUT_MS,
    });
    const finish = (error?: Error) => {
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    socket.once("secureConnect", () => finish());
    socket.once("timeout", () => finish(new Error(`TLS timeout for ${host}:${port}`)));
    socket.once("error", finish);
  });
}

/** A plain ws:// LiveKit is on this machine's bridge: reaching its port is all there is to check. */
async function probeTcp(value: string): Promise<void> {
  const url = new URL(value);
  await new Promise<void>((resolve, reject) => {
    const socket = tcpConnect({ host: url.hostname, port: url.port ? Number(url.port) : 80, timeout: PROBE_TIMEOUT_MS });
    const finish = (error?: Error) => {
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    socket.once("connect", () => finish());
    socket.once("timeout", () => finish(new Error(`TCP timeout for ${url.host}`)));
    socket.once("error", finish);
  });
}

async function fetchJson<Output>(url: string, schema: v.GenericSchema<unknown, Output>): Promise<Output> {
  const response = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  const value: unknown = await response.json();
  return v.parse(schema, value);
}

/**
 * The journal is this container's own durable store: failing to open it is a
 * fault a restart can act on. Its backlog is not. An unreachable app leaves
 * rows waiting, and restarting would only cut every meeting on this host
 * while the rows stay exactly where they are. The backlog is reported.
 */
function checkJournal(path: string): void {
  const journal = new TranscriptJournal(path);
  try {
    const { pending, oldestAt } = journal.status();
    if (pending > 0) {
      console.error(
        `Transcript journal holds ${pending} undelivered segment(s), ` +
        `the oldest ${Math.round((Date.now() - (oldestAt ?? Date.now())) / 1_000)}s old`,
      );
    }
  } finally {
    journal.close();
  }
}

async function checkAgent(): Promise<void> {
  const config = loadAgentConfig();
  const worker = await fetchJson("http://127.0.0.1:8081/worker", workerHealthSchema);
  if (worker.worker_type !== "JT_PUBLISHER") {
    throw new Error("publisher worker is not registered");
  }
  const connectionStatuses = readActiveTranscriptionConnectionStatuses();
  // A job-level ctx.connect() failure cannot distinguish a broken container
  // from the routine case where its room or publisher disappeared during
  // dispatch. It is therefore telemetry, not readiness evidence: restarting
  // this shared process would interrupt unrelated meetings and cannot repair a
  // vanished job. Container-owned dependencies and active Deepgram connection
  // states below remain authoritative readiness signals.
  // A broken Deepgram connection belongs to one publisher job, for the same
  // reason a job-level ctx.connect() failure does: restarting this shared
  // process cannot re-issue a rejected API key or revive a refused upstream,
  // and it would cut every other meeting on this container while failing in
  // exactly the same way afterwards. Report each one loudly — the phase and
  // its message are the whole diagnosis — and let `probeTls` below speak for
  // the container's actual reachability of Deepgram, which is the only part of
  // this a restart can repair.
  for (const status of connectionStatuses) {
    if (!isUnhealthyTranscriptionConnection(status)) continue;
    console.error(
      `Deepgram transcription connection ${status.id} is ${status.phase}: ` +
      (status.message ?? "connection did not open within 50 seconds"),
    );
  }
  // Dropped results are data already lost; failing readiness here would shed
  // the rest of the meeting without recovering anything. They are logged where
  // they happen, and the per-connection counter is echoed so an accumulating
  // loss is visible to anyone probing health without trawling logs.
  for (const status of connectionStatuses) {
    if ((status.droppedResults ?? 0) > 0) {
      console.error(
        `Transcription connection ${status.id} has ${status.droppedResults} ` +
        `result(s) that will not be persisted (last: ${status.lastDropReason ?? "unknown"})`,
      );
    }
  }
  checkJournal(config.transcriptJournalPath);
  await Promise.all([
    config.livekitUrl.startsWith("ws://") ? probeTcp(config.livekitUrl) : probeTls(config.livekitUrl),
    probeTls(config.deepgramBaseUrl),
    probeTls(config.appUrl),
  ]);
}

async function runHealthcheck(service: string): Promise<void> {
  if (statSync(CA_BUNDLE).size === 0) throw new Error("system CA bundle is empty");
  if (service === "agent") return await checkAgent();
  throw new Error(`unknown healthcheck service: ${service}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runHealthcheck(process.argv[2] ?? "")
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
