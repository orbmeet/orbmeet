import { readFileSync } from "node:fs";
import * as v from "valibot";

function readSetting(name: string): string | undefined {
  const direct = process.env[name]?.trim();
  if (direct) return direct;
  const file = process.env[`${name}_FILE`]?.trim();
  if (!file) return undefined;
  return readFileSync(file, "utf8").trim() || undefined;
}

const text = v.pipe(v.string(), v.trim(), v.nonEmpty());

/** A whole-number setting, read from its environment string as plain digits. */
function integerSetting(min: number, max = Number.MAX_SAFE_INTEGER) {
  return v.pipe(v.string(), v.digits(), v.toNumber(), v.safeInteger(), v.minValue(min), v.maxValue(max));
}

// Valibot's default message for a failed pattern quotes the value it received.
// Settings that hold key material state their own, so a malformed secret is
// never printed in the startup error.

function urlSetting(scheme: "https://" | "wss://", message: string) {
  return v.pipe(v.string(), v.url(), v.startsWith(scheme, message));
}

// A private IPv4 address: on a media node, its own LiveKit on the
// containers' bridge, which never leaves the machine.
const PRIVATE_HOST = String.raw`(?:10(?:\.\d{1,3}){3}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|192\.168(?:\.\d{1,3}){2})`;

/** A secure URL, or its plaintext form on this machine (the local dev stack) or, when allowed, a private address. */
function secureOrLoopbackUrl(secure: "https" | "wss", message: string, { privateHosts = false } = {}) {
  const plain = secure === "https" ? "http" : "ws";
  const hosts = privateHosts ? String.raw`localhost|127\.0\.0\.1|${PRIVATE_HOST}` : String.raw`localhost|127\.0\.0\.1`;
  const local = new RegExp(String.raw`^${plain}://(?:${hosts})(:\d+)?(/|$)`);
  return v.pipe(
    v.string(),
    v.url(),
    v.check((value) => value.startsWith(`${secure}://`) || local.test(value), message),
  );
}

const agentConfigSchema = v.object({
  // Plain ws:// only reaches a LiveKit on this machine: the dev one, or on a
  // media node its own, at the containers' bridge gateway.
  livekitUrl: secureOrLoopbackUrl("wss", "must be a secure WebSocket URL, or ws:// on this machine or a private address", {
    privateHosts: true,
  }),
  livekitApiKey: v.pipe(v.string(), v.nonEmpty()),
  livekitApiSecret: v.pipe(v.string(), v.nonEmpty()),
  deepgramApiKey: v.pipe(v.string(), v.nonEmpty()),
  deepgramBaseUrl: urlSetting("https://", "must be an HTTPS URL"),
  maxActiveJobs: integerSetting(1, 500),
  transcriptJournalPath: text,
  // Plain HTTP only reaches a dev server on this machine.
  appUrl: secureOrLoopbackUrl("https", "must be an HTTPS URL, or HTTP on localhost"),
  internalKeyId: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{1,64}$/, "must be 1-64 base64url characters")),
  internalSecret: v.pipe(v.string(), v.minLength(32, "must be at least 32 characters")),
  maxUnresolvedAgeMs: integerSetting(60_000),
});

export type AgentConfig = v.InferOutput<typeof agentConfigSchema>;

/** Parse settings, reporting every invalid one at once rather than the first. */
function parseConfig<Schema extends v.GenericSchema>(schema: Schema, input: unknown): v.InferOutput<Schema> {
  const result = v.safeParse(schema, input);
  if (result.success) return result.output;
  const problems = result.issues.map((issue) => `${v.getDotPath(issue) ?? "config"}: ${issue.message}`);
  throw new Error(`Invalid configuration:\n  ${problems.join("\n  ")}`);
}

export function loadAgentConfig(): AgentConfig {
  const config = parseConfig(agentConfigSchema, {
    livekitUrl: readSetting("LIVEKIT_URL"),
    livekitApiKey: readSetting("LIVEKIT_API_KEY"),
    livekitApiSecret: readSetting("LIVEKIT_API_SECRET"),
    deepgramApiKey: readSetting("DEEPGRAM_API_KEY"),
    deepgramBaseUrl: readSetting("DEEPGRAM_BASE_URL") ?? "https://api.deepgram.com",
    maxActiveJobs: readSetting("TRANSCRIPTION_MAX_ACTIVE_JOBS") ?? "16",
    transcriptJournalPath: readSetting("TRANSCRIPTION_JOURNAL_PATH") ?? "./data/transcript-journal.db",
    appUrl: readSetting("APP_URL"),
    internalKeyId: readSetting("TRANSCRIPTION_INTERNAL_KEY_ID"),
    internalSecret: readSetting("TRANSCRIPTION_INTERNAL_SECRET"),
    // How long a segment waits for the app to resolve its participant — a
    // briefly disconnected participant may still reconnect — before it is
    // set aside.
    maxUnresolvedAgeMs: readSetting("TRANSCRIPTION_MAX_UNRESOLVED_AGE_MS") ?? "600000",
  });
  return { ...config, appUrl: config.appUrl.replace(/\/$/, "") };
}

export function configureLiveKitEnvironment(config: AgentConfig): void {
  process.env.LIVEKIT_URL = config.livekitUrl;
  process.env.LIVEKIT_API_KEY = config.livekitApiKey;
  process.env.LIVEKIT_API_SECRET = config.livekitApiSecret;
}
