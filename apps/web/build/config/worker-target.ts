import { existsSync, readFileSync } from "node:fs";

// The leaf owner of the Worker's plain values: compatibility settings and the
// merged deployment vars. cloudflare.config.ts builds its bindings from this
// module, and build-time tooling (vite.config.ts defines, the D1 test
// runtime, header generation) reads the same values here — so no consumer
// ever has to load the config module (and its worker graph) to see a value.

/**
 * This deployment's values over the defaults below, from the gitignored
 * cloudflare.deploy.json (see cloudflare.deploy.json.example). Every key is
 * optional; a fresh clone without the file runs against the placeholders.
 */
interface DeployOverlay {
  /** The deployed Worker's name. Local dev and fresh clones use the default. */
  name?: string;
  /** The D1 database to bind. Omitted: `cf` provisions one named orbmeet-db. */
  databaseId?: string;
  /** Custom domains (apex only; `www` is an external redirect rule). */
  domains?: string[];
  /** Overrides for the plain-text vars below. */
  vars?: Partial<Record<string, string>>;
}

const deployUrl = new URL("../../cloudflare.deploy.json", import.meta.url);
const deploy: DeployOverlay = existsSync(deployUrl)
  ? (JSON.parse(readFileSync(deployUrl, "utf8")) as DeployOverlay)
  : {};

export const workerName = deploy.name ?? "orbmeet";
export const databaseId = deploy.databaseId;
export const domains = deploy.domains;

export const compatibilityDate = "2026-03-29";
export const compatibilityFlags = ["nodejs_compat"] as const;

// Plain deployment values: cloudflare.config.ts wraps each one for `env`,
// and everything that needs the value rather than the binding reads it here.
const defaultVars = {
  APP_NAME: "Orb Meet",
  APP_URL: "https://your-domain.example",
  ENVIRONMENT: "production",
  // Sender for all transactional mail. The local part must belong to a
  // domain onboarded to Email Service, or sends fail E_SENDER_NOT_VERIFIED.
  EMAIL_FROM_ADDRESS: "Orb Meet <noreply@your-domain.example>",
  // Must match the R2 bucket bound in cloudflare.config.ts; used by presigned
  // S3 URLs.
  R2_BUCKET_NAME: "orbmeet-storage",
  AI_MODEL: "gemini-3.1-flash-lite-preview",
  AI_MODEL_FALLBACK: "gemma-4-31b-it",
  MATHINK_ORIGIN_URL: "https://mathink-origin.your-domain.example/api/mathink",
  // UptimeRobot monitor ids for /status. Video meetings takes one monitor per
  // media node, comma-separated; it is down only while every node is.
  UPTIMEROBOT_MONITOR_LIVEKIT_ID: "",
  UPTIMEROBOT_MONITOR_WHITEBOARD_ID: "",
  // Paddle Billing, all public: Paddle.js's client token and Catalog price ids.
  VITE_PADDLE_CLIENT_TOKEN: "",
  PADDLE_PRICE_ID_PRO: "",
  // Recurring $10/month price for one active Organization member.
  PADDLE_PRICE_ID_ORG_SEAT: "",
};

export const deployVars: Record<string, string> = {
  ...defaultVars,
  ...deploy.vars,
};
