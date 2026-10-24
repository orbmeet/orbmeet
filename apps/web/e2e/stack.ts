// Ports, URLs and shared secrets of the smoke-test stack. Every port sits
// outside what a dev stack (3000, 27880, 8787) or a production media node
// (7880-7885) uses, so the suite can run beside either.
import { fileURLToPath } from "node:url";

export const WEB_PORT = 13000;
export const WHITEBOARD_PORT = 18787;
export const LIVEKIT_PORT = 17880;

export const WEB_URL = `http://localhost:${WEB_PORT}`;
export const WHITEBOARD_URL = `http://localhost:${WHITEBOARD_PORT}`;

export const WEB_DIR = fileURLToPath(new URL("..", import.meta.url));
export const WHITEBOARD_DIR = fileURLToPath(new URL("../../whiteboard-server", import.meta.url));
/** Everything a run writes outside the D1/DO state; wiped by e2e/run.ts. */
export const RUN_DIR = fileURLToPath(new URL("../.cloudflare/e2e-run", import.meta.url));
/** The running whiteboard server's pid, kept by e2e/whiteboard-supervisor.ts. */
export const WHITEBOARD_PID_FILE = `${RUN_DIR}/whiteboard.pid`;

export const LIVEKIT_CONTAINER = "orbmeet-e2e-livekit";
export const LIVEKIT_IMAGE = "livekit/livekit-server:v1.13.6";

// Test-only secrets. They guard nothing outside this loopback stack.
const WHITEBOARD_JWT_KEYS = JSON.stringify({ e2e: "e2e-whiteboard-jwt-key-0123456789abcdef" });
const WHITEBOARD_COMMAND_KEYS = JSON.stringify({ e2e: "e2e-whiteboard-command-key-0123456789abcdef" });
const WHITEBOARD_CALLBACK_KEYS = JSON.stringify({ e2e: "e2e-whiteboard-callback-key-0123456789abcdef" });

/** The Worker's `.dev.vars.e2e`. */
export const WEB_VARS: Record<string, string> = {
  APP_URL: WEB_URL,
  ENVIRONMENT: "development",
  AUTH_SECRET: "e2e-auth-secret-0123456789abcdef0123456789",
  EMAIL_FROM_ADDRESS: "Orb Meet <noreply@example.com>",
  NODES: JSON.stringify({
    e2e: {
      media: { url: `ws://localhost:${LIVEKIT_PORT}`, capacity: 100, keys: { e2ekey: "e2e-livekit-secret-0123456789abcdef" } },
      whiteboard: {
        url: WHITEBOARD_URL,
        jwt: JSON.parse(WHITEBOARD_JWT_KEYS),
        command: JSON.parse(WHITEBOARD_COMMAND_KEYS),
        callback: JSON.parse(WHITEBOARD_CALLBACK_KEYS),
      },
    },
  }),
  TRANSCRIPTION_INTERNAL_KEYS: JSON.stringify({ "agent-e2e": "e2e-transcription-key-0123456789abcdef" }),
  // No R2 credentials: the bucket is simulated in the e2e state dir.
  R2_ACCESS_KEY_ID: "",
  R2_SECRET_ACCESS_KEY: "",
  R2_ACCOUNT_ID: "",
  R2_BUCKET_NAME: "orbmeet-storage-e2e",
  MATHINK_ORIGIN_URL: "http://127.0.0.1:9",
  MATHINK_ORIGIN_SECRET: "e2e-mathink-secret",
};

/**
 * The whiteboard server's environment. It also reads the developer's `.env`
 * (see whiteboard-supervisor.ts), for the board assistant; these win over it.
 */
export const WHITEBOARD_ENV: Record<string, string> = {
  NODE_ENV: "development",
  PORT: String(WHITEBOARD_PORT),
  APP_URL: WEB_URL,
  ALLOWED_ORIGINS: WEB_URL,
  DATA_DIR: `${RUN_DIR}/whiteboard`,
  WHITEBOARD_JWT_KEYS,
  WHITEBOARD_COMMAND_KEYS,
  WHITEBOARD_CALLBACK_KEYS,
  R2_ACCESS_KEY_ID: "",
  R2_SECRET_ACCESS_KEY: "",
  R2_ACCOUNT_ID: "",
  R2_BUCKET_NAME: "",
};
