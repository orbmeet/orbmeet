import { readFileSync } from "node:fs";
import { parseKeyring, type Keyring } from "@orbmeet/primitives";
import { parseTrustedProxyList } from "./net-security.ts";
import { hasR2Config, type R2Config } from "../persistence/r2.ts";
import { logError, logWarn } from "../lib/log.ts";

export interface WhiteboardServerConfig {
  port: number;
  dataDir: string;
  appUrl: string;
  /** Verifies the Worker's commands (`WHITEBOARD_COMMAND_KEYS`). */
  commandKeyring: Keyring;
  /** Signs this server's calls to the Worker (`WHITEBOARD_CALLBACK_KEYS`). */
  callbackKeyring: Keyring;
  /** Verifies the tokens the Worker mints for this node. */
  jwtKeyring: Keyring;
  r2Config: R2Config;
  /** Local stand-in for R2, used only in development when R2 is not configured. */
  developmentObjectStoreDir: string | null;
  allowedOrigins: string[];
  allowInsecureAllOrigins: boolean;
  trustedProxyIps: ReturnType<typeof parseTrustedProxyList>;
  ipRateLimit: number;
  ipRateWindowMs: number;
  ipRateMaxKeys: number;
  /** Null when no model is configured: the assistant is then unavailable. */
  assistant: AssistantModelConfig | null;
}

const ASSISTANT_PROVIDERS = ["google", "anthropic"] as const;

export interface AssistantModelConfig {
  provider: (typeof ASSISTANT_PROVIDERS)[number];
  modelId: string;
  apiKey: string;
}

export type OriginPolicy = Pick<
  WhiteboardServerConfig,
  "allowedOrigins" | "allowInsecureAllOrigins"
>;

/** Why an origin was refused, for the caller's log line. */
export type OriginRejectionReason =
  | "missing origin"
  | "forbidden origin"
  | "no allowed origins configured";

/**
 * The single origin admission rule, shared by the WebSocket upgrade and every
 * state-changing HTTP route. A missing `Origin` is a rejection rather than an
 * exemption: browsers always send one on a cross-origin request, so a request
 * without it is not one our client made, and treating absence as "nothing to
 * check" is exactly the shape that turns an origin check into a no-op.
 *
 * Returns null when the origin is admissible.
 */
export function checkRequestOrigin(
  origin: string | null,
  { allowedOrigins, allowInsecureAllOrigins }: OriginPolicy,
): OriginRejectionReason | null {
  if (!origin) return "missing origin";
  if (allowedOrigins.length > 0) {
    return allowedOrigins.includes(origin) ? null : "forbidden origin";
  }
  return allowInsecureAllOrigins ? null : "no allowed origins configured";
}

function readSecret(envVar: string): string {
  const fileVar = process.env[envVar + "_FILE"];
  if (fileVar) {
    try {
      return readFileSync(fileVar, "utf-8").trim();
    } catch {
      logError(`Failed to read secret file ${fileVar} for ${envVar}`);
    }
  }
  return process.env[envVar] || "";
}

function readKeyring(envVar: string): Keyring {
  const keyring = parseKeyring(readSecret(envVar));
  if (!keyring) {
    logError(
      `${envVar} must be a JSON object of key ids to secrets of at least 32 characters, e.g. {"k1":"<openssl rand -hex 32>"}`,
    );
    process.exit(1);
  }
  return keyring;
}

function isLocalAppUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.hostname === "localhost" || url.hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

export function trustedProxyConfigurationWarning(
  appUrl: string,
  trustedProxyCount: number,
): string | null {
  return !isLocalAppUrl(appUrl) && trustedProxyCount === 0
    ? "[whiteboard-server] TRUST_PROXY_IPS is empty for a non-local deployment; forwarded client IPs will be ignored and edge-level rate limiting should be enabled."
    : null;
}

function readPositiveNumber(envVar: string, fallback: number): number {
  const value = Number(process.env[envVar]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function readPositiveInt(envVar: string, fallback: number): number {
  const value = Math.floor(readPositiveNumber(envVar, fallback));
  return value > 0 ? value : fallback;
}

function readPort(): number {
  const port = Number(process.env.PORT ?? 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    logError("PORT must be an integer between 1 and 65535");
    process.exit(1);
  }
  return port;
}

function assertSecureAppUrl(rawUrl: string): void {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    logError("APP_URL must be a valid URL");
    process.exit(1);
  }

  if (url.protocol === "https:") return;
  if (url.protocol === "http:" && isLocalAppUrl(rawUrl)) return;

  logError("APP_URL must use https, except for localhost development");
  process.exit(1);
}

/**
 * `ASSISTANT_MODEL` names the model as `<provider>/<model id>`, for example
 * `google/gemini-3.8-flash` or `anthropic/claude-sonnet-5-5`, and
 * `AI_API_KEY` is that provider's key, the same one the Worker uses. Both or
 * neither.
 */
export function readAssistantModelConfig(
  model: string,
  apiKey: string,
): AssistantModelConfig | null | string {
  if (!model && !apiKey) return null;
  if (!model || !apiKey) return "ASSISTANT_MODEL and AI_API_KEY are set together or not at all";
  const separator = model.indexOf("/");
  const provider = model.slice(0, separator);
  const modelId = model.slice(separator + 1);
  if (separator < 1 || !modelId || !(ASSISTANT_PROVIDERS as readonly string[]).includes(provider)) {
    return `ASSISTANT_MODEL must be <provider>/<model id> with a provider of ${ASSISTANT_PROVIDERS.join(", ")}`;
  }
  return { provider: provider as AssistantModelConfig["provider"], modelId, apiKey };
}

export function loadWhiteboardServerConfig(): WhiteboardServerConfig {

  // HS256 tokens are offline-brute-forceable from any captured JWT when the
  // key is short; a keyring's secrets are at least 32 characters.
  const jwtKeyring = readKeyring("WHITEBOARD_JWT_KEYS");
  const commandKeyring = readKeyring("WHITEBOARD_COMMAND_KEYS");
  const callbackKeyring = readKeyring("WHITEBOARD_CALLBACK_KEYS");
  const secrets = [...jwtKeyring.values(), ...commandKeyring.values(), ...callbackKeyring.values()];
  if (new Set(secrets).size !== secrets.length) {
    logError(
      "WHITEBOARD_JWT_KEYS, WHITEBOARD_COMMAND_KEYS and WHITEBOARD_CALLBACK_KEYS must not share a secret",
    );
    process.exit(1);
  }

  const appUrl = (process.env.APP_URL || "").trim().replace(/\/+$/, "");
  if (!appUrl) {
    logError("APP_URL is required for whiteboard authority and PDF import grants");
    process.exit(1);
  }
  assertSecureAppUrl(appUrl);

  const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const allowInsecureAllOrigins =
    process.env.ALLOW_INSECURE_ALL_ORIGINS === "true" ||
    (isLocalAppUrl(appUrl) && process.env.NODE_ENV === "development");

  if (allowedOrigins.length === 0) {
    if (!allowInsecureAllOrigins) {
      logError(
        "[whiteboard-server] ALLOWED_ORIGINS is required unless ALLOW_INSECURE_ALL_ORIGINS=true.",
      );
      process.exit(1);
    }
    logWarn("[whiteboard-server] ALLOWED_ORIGINS is not set — allowing all origins (development mode).");
  }

  const trustedProxyIps = parseTrustedProxyList(process.env.TRUST_PROXY_IPS);
  const proxyWarning = trustedProxyConfigurationWarning(appUrl, trustedProxyIps.length);
  if (proxyWarning) logWarn(proxyWarning);

  const dataDir = process.env.DATA_DIR || "/data/rooms";
  const r2Config: R2Config = {
    accessKeyId: readSecret("R2_ACCESS_KEY_ID"),
    secretAccessKey: readSecret("R2_SECRET_ACCESS_KEY"),
    accountId: readSecret("R2_ACCOUNT_ID"),
    bucketName: readSecret("R2_BUCKET_NAME"),
  };
  let developmentObjectStoreDir: string | null = null;
  if (!hasR2Config(r2Config)) {
    // R2 holds revisions, captures and PDF imports. Development may use a
    // local directory instead.
    if (process.env.NODE_ENV !== "development") {
      logError("R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ACCOUNT_ID and R2_BUCKET_NAME are required");
      process.exit(1);
    }
    developmentObjectStoreDir = process.env.OBJECT_STORE_DIR || `${dataDir}/.objects`;
    logWarn(`[whiteboard-server] R2 is not configured; storing snapshots in ${developmentObjectStoreDir}`);
  }

  const assistant = readAssistantModelConfig(
    (process.env.ASSISTANT_MODEL || "").trim(),
    readSecret("AI_API_KEY"),
  );
  if (typeof assistant === "string") {
    logError(assistant);
    process.exit(1);
  }
  if (!assistant) logWarn("[whiteboard-server] ASSISTANT_MODEL is not set; the board assistant is unavailable.");

  return {
    port: readPort(),
    dataDir,
    appUrl,
    commandKeyring,
    callbackKeyring,
    jwtKeyring,
    r2Config,
    developmentObjectStoreDir,
    allowedOrigins,
    allowInsecureAllOrigins,
    trustedProxyIps,
    ipRateLimit: readPositiveInt("IP_RATE_LIMIT", 60),
    ipRateWindowMs: readPositiveInt("IP_RATE_WINDOW_MS", 60_000),
    ipRateMaxKeys: readPositiveInt("IP_COUNT_CAP", 50_000),
    assistant,
  };
}

