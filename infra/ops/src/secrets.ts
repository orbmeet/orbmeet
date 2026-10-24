import { randomBytes } from "node:crypto";
import { existsSync, renameSync, rmSync } from "node:fs";
import { keepsKeyringOrder, MAX_KEYRING_KEYS } from "@orbmeet/nodes";
import { parseKeyring } from "@orbmeet/primitives";
import { AGE_IDENTITY, RECIPIENTS_FILE, SECRETS_FILE } from "./catalog.ts";
import type { Inventory } from "./inventory.ts";
import { mediaNodes } from "./inventory.ts";
import { OpsError, type Shell } from "./shell.ts";

/*
 * Every secret the nodes and the Worker use lives in secrets.age: JSON,
 * encrypted with age to the public keys in age-recipients.txt and committed.
 * Whoever holds one of those private keys can release from any machine.
 */

// Each node's whiteboard keyrings (see packages/primitives/src/signed-request.ts):
// key ids to secrets; the first key signs, every key verifies. JWT signs the
// tokens the Worker mints for the node, COMMAND the Worker's calls to it,
// CALLBACK its calls to the Worker. Key ids name the node, so the Worker
// knows which node a token or a call belongs to.
export const WHITEBOARD_KEYRINGS = ["WHITEBOARD_JWT_KEYS", "WHITEBOARD_COMMAND_KEYS", "WHITEBOARD_CALLBACK_KEYS"] as const;
type WhiteboardKeyring = (typeof WHITEBOARD_KEYRINGS)[number];
export const R2_KEYS = ["R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_ACCOUNT_ID", "R2_BUCKET_NAME"] as const;
// Egress's own R2 token, held by every media node: recordings are uploaded
// with it, so the Worker never sends a storage credential to a node.
export const EGRESS_R2_KEYS = ["EGRESS_R2_ACCESS_KEY_ID", "EGRESS_R2_SECRET_ACCESS_KEY"] as const;
/** The speech-to-text provider every node's transcription agent uses. */
export const DEEPGRAM_KEY = "DEEPGRAM_API_KEY";
/**
 * An Axiom ingest token. Every node ships its logs and its failed units'
 * journals with it, so a node without one would fail unseen: it is required.
 */
const AXIOM_KEY = "AXIOM_TOKEN";
/** Created outside this tool and imported with `set-secret`. */
export const IMPORTED_KEYS = [...R2_KEYS, ...EGRESS_R2_KEYS, DEEPGRAM_KEY, AXIOM_KEY] as const;
// Shared before each node had its own; removed from the file when it is next written.
const RETIRED_KEYS = ["WHITEBOARD_JWT_SECRET", "WHITEBOARD_COMMAND_KEYS", "WHITEBOARD_CALLBACK_KEYS"];
/**
 * The one model provider key for everything AI: the Worker's meeting summaries
 * and the whiteboard assistant. Each is off without it.
 */
export const AI_KEY = "AI_API_KEY";
// Keys the Worker still accepts from transcription agents no node runs any
// more, for retiring an agent while its journal drains.
const RETIRING_TRANSCRIPTION_KEYS = "TRANSCRIPTION_RETIRING_KEYS";
/** What `set-secret` may set. */
const SETTABLE_KEYS: readonly string[] = [...IMPORTED_KEYS, AI_KEY, RETIRING_TRANSCRIPTION_KEYS];

// LIVEKIT_KEYS is a keyring object; the first key signs, every key verifies.
// The transcription agent has its own LiveKit key and its own key for
// delivering transcripts to the Worker (TRANSCRIPTION_INTERNAL_KEYS).
type NodeSecrets = Record<WhiteboardKeyring, Record<string, string>> & {
  LIVEKIT_KEYS: Record<string, string>;
  LIVEKIT_EGRESS_API_KEY: string;
  LIVEKIT_EGRESS_API_SECRET: string;
  REDIS_PASSWORD: string;
  LIVEKIT_TRANSCRIPTION_API_KEY: string;
  LIVEKIT_TRANSCRIPTION_API_SECRET: string;
  TRANSCRIPTION_INTERNAL_KEY_ID: string;
  TRANSCRIPTION_INTERNAL_SECRET: string;
};

export type Secrets = Record<(typeof IMPORTED_KEYS)[number], string> & {
  [AI_KEY]?: string;
  [RETIRING_TRANSCRIPTION_KEYS]?: string;
  nodes: Record<string, NodeSecrets>;
};

const KEY_ID = /^[A-Za-z0-9_-]{1,64}$/;

const hex = (bytes: number) => randomBytes(bytes).toString("hex");

function newNodeSecrets(name: string): NodeSecrets {
  return {
    LIVEKIT_KEYS: { [`${name}-${hex(8)}`]: hex(32) },
    LIVEKIT_EGRESS_API_KEY: `${name}-egress-${hex(8)}`,
    LIVEKIT_EGRESS_API_SECRET: hex(32),
    REDIS_PASSWORD: hex(32),
    LIVEKIT_TRANSCRIPTION_API_KEY: `${name}-transcription-${hex(8)}`,
    LIVEKIT_TRANSCRIPTION_API_SECRET: hex(32),
    TRANSCRIPTION_INTERNAL_KEY_ID: `${name}-${hex(8)}`,
    TRANSCRIPTION_INTERNAL_SECRET: hex(32),
    WHITEBOARD_JWT_KEYS: { [`${name}-jwt-${hex(8)}`]: hex(32) },
    WHITEBOARD_COMMAND_KEYS: { [`${name}-command-${hex(8)}`]: hex(32) },
    WHITEBOARD_CALLBACK_KEYS: { [`${name}-callback-${hex(8)}`]: hex(32) },
  };
}

function checkValue(label: string, value: unknown, minimum = 1): void {
  if (typeof value !== "string" || value.trim().length < minimum) {
    throw new OpsError(`${label} must be a string of at least ${minimum} characters`
      + (value === undefined ? `; set it with \`pnpm ops set-secret ${label}\`` : ""));
  }
  if (value !== value.trim() || Array.from({ length: value.length }, (_, i) => value.charCodeAt(i)).some((code) => code < 32)) {
    throw new OpsError(`${label} must not contain control characters or surrounding whitespace`);
  }
}

function keyringSecrets(label: string, value: string | Record<string, string>): string[] {
  const keyring = parseKeyring(typeof value === "string" ? value : JSON.stringify(value));
  if (!keyring) throw new OpsError(`${label} must be a JSON object of key ids to secrets of 32-512 characters`);
  return [...keyring.values()];
}

/** Throws on the first problem; messages name the offending key, never its value. */
export function validateSecrets(c: Secrets): Secrets {
  if (typeof c !== "object" || c === null || typeof c.nodes !== "object" || c.nodes === null) {
    throw new OpsError('Secrets must be an object with a "nodes" object');
  }
  for (const key of IMPORTED_KEYS) checkValue(key, c[key]);
  if (!/^[\x21-\x7e]+$/.test(c[AXIOM_KEY])) throw new OpsError(`${AXIOM_KEY} must be a token without spaces`);
  const apiKeys: string[] = [];
  const whiteboardKeyIds: string[] = [];
  for (const [name, node] of Object.entries(c.nodes)) {
    const keyrings = ["LIVEKIT_KEYS", ...WHITEBOARD_KEYRINGS] as const;
    for (const keyring of keyrings) {
      const value = node?.[keyring];
      if (typeof value !== "object" || value === null || Array.isArray(value)
          || Object.keys(value).length < 1 || Object.keys(value).length > MAX_KEYRING_KEYS
          || !Object.keys(value).every((id) => KEY_ID.test(id) && keepsKeyringOrder(id))) {
        throw new OpsError(
          `nodes.${name}.${keyring} must be an object of 1-${MAX_KEYRING_KEYS} key ids (not plain numbers) to secrets`,
        );
      }
    }
    const keys = node.LIVEKIT_KEYS;
    const whiteboard = WHITEBOARD_KEYRINGS.flatMap((key) => keyringSecrets(`nodes.${name}.${key}`, node[key]));
    if (new Set(whiteboard).size !== whiteboard.length) throw new OpsError(`nodes.${name}: whiteboard secrets must be distinct`);
    whiteboardKeyIds.push(...WHITEBOARD_KEYRINGS.flatMap((key) => Object.keys(node[key])));
    for (const [id, secret] of Object.entries(keys)) checkValue(`nodes.${name}.LIVEKIT_KEYS.${id}`, secret, 32);
    for (const key of ["LIVEKIT_EGRESS_API_KEY", "LIVEKIT_EGRESS_API_SECRET", "REDIS_PASSWORD",
      "LIVEKIT_TRANSCRIPTION_API_KEY", "LIVEKIT_TRANSCRIPTION_API_SECRET", "TRANSCRIPTION_INTERNAL_KEY_ID",
      "TRANSCRIPTION_INTERNAL_SECRET"] as const) {
      checkValue(`nodes.${name}.${key}`, node[key], key.endsWith("_KEY") || key.endsWith("_KEY_ID") ? 1 : 32);
    }
    if (!KEY_ID.test(node.TRANSCRIPTION_INTERNAL_KEY_ID)) {
      throw new OpsError(`nodes.${name}.TRANSCRIPTION_INTERNAL_KEY_ID must be 1-64 base64url characters`);
    }
    apiKeys.push(...Object.keys(keys), node.LIVEKIT_EGRESS_API_KEY, node.LIVEKIT_TRANSCRIPTION_API_KEY);
  }
  // Webhooks name their node only through the signing key's id.
  if (new Set(apiKeys).size !== apiKeys.length) throw new OpsError("Every LiveKit API key id must be unique across nodes");
  // Tokens and calls name their node only through their key's id.
  if (new Set(whiteboardKeyIds).size !== whiteboardKeyIds.length) {
    throw new OpsError("Every whiteboard key id must be unique across nodes");
  }
  const transcriptionKeys = Object.values(c.nodes).map((node) => node.TRANSCRIPTION_INTERNAL_KEY_ID);
  const retiring = c[RETIRING_TRANSCRIPTION_KEYS];
  if (retiring !== undefined) {
    keyringSecrets(RETIRING_TRANSCRIPTION_KEYS, retiring);
    transcriptionKeys.push(...Object.keys(JSON.parse(retiring) as object));
  }
  if (new Set(transcriptionKeys).size !== transcriptionKeys.length) {
    throw new OpsError("Every transcription key id must be unique");
  }
  return c;
}

/**
 * Generate what is missing: every secret of a new node, and on an existing
 * node the secrets added since it was set up. Nothing that exists is
 * replaced. A node that left the inventory takes its secrets with it: should
 * it come back, it is a new node with new keys.
 */
export function fillSecrets(inv: Inventory, current: Partial<Secrets>): { secrets: Secrets; changed: boolean } {
  const c = { ...current, nodes: { ...current.nodes } } as Secrets;
  let changed = false;
  for (const key of RETIRED_KEYS) {
    if (key in c) {
      delete (c as Record<string, unknown>)[key];
      changed = true;
    }
  }
  for (const name of Object.keys(c.nodes)) {
    if (!(name in inv.nodes)) {
      delete c.nodes[name];
      changed = true;
    }
  }
  for (const name of Object.keys(inv.nodes)) {
    const existing = c.nodes[name] ?? {};
    const filled = { ...newNodeSecrets(name), ...existing };
    if (Object.keys(filled).length !== Object.keys(existing).length) {
      c.nodes[name] = filled;
      changed = true;
    }
  }
  return { secrets: c, changed };
}

/** The key the Worker and the node's webhooks sign with: its keyring's first. */
export function signingKey(c: Secrets, name: string): [string, string] {
  const [first] = Object.entries(c.nodes[name].LIVEKIT_KEYS);
  return first;
}

/** The Worker's TRANSCRIPTION_INTERNAL_KEYS: each media node's agent key, and any key still retiring. */
export function transcriptionKeysSecret(inv: Inventory, c: Secrets): string {
  const keys: Record<string, string> = {};
  for (const name of mediaNodes(inv)) {
    keys[c.nodes[name].TRANSCRIPTION_INTERNAL_KEY_ID] = c.nodes[name].TRANSCRIPTION_INTERNAL_SECRET;
  }
  return JSON.stringify({ ...keys, ...JSON.parse(c[RETIRING_TRANSCRIPTION_KEYS] ?? "{}") });
}

// ---------------------------------------------------------------------------
// The encrypted file
// ---------------------------------------------------------------------------

export interface SecretStore {
  read(): Promise<Partial<Secrets> | null>;
  write(secrets: Partial<Secrets>): Promise<void>;
}

/** secrets.age, read and written with the age CLI. Plaintext only ever passes through pipes. */
export function ageStore(shell: Shell, file = SECRETS_FILE): SecretStore {
  return {
    async read() {
      if (!existsSync(file)) return null;
      if (!existsSync(AGE_IDENTITY)) {
        throw new OpsError(`No age key at ${AGE_IDENTITY} to decrypt ${file}; set ORBMEET_AGE_KEY to its path`);
      }
      return JSON.parse(await shell(["age", "--decrypt", "--identity", AGE_IDENTITY, file], { capture: true }));
    },
    async write(secrets) {
      const next = `${file}.next`;
      try {
        await shell(["age", "--encrypt", "--armor", "--recipients-file", RECIPIENTS_FILE, "--output", next],
          { input: `${JSON.stringify(secrets, null, 2)}\n` });
        renameSync(next, file);
      } finally {
        rmSync(next, { force: true });
      }
    },
  };
}

/** Load, complete and validate the secrets, saving any that were generated. */
export async function loadSecrets(inv: Inventory, store: SecretStore): Promise<Secrets> {
  const { secrets, changed } = fillSecrets(inv, await store.read() ?? { nodes: {} });
  validateSecrets(secrets);
  if (changed) await store.write(secrets);
  return secrets;
}

/** Import one secret created outside this tool, such as a rotated R2 token. */
export async function setSecret(inv: Inventory, store: SecretStore, name: string, value: string): Promise<void> {
  if (!SETTABLE_KEYS.includes(name)) throw new OpsError(`set-secret takes one of ${SETTABLE_KEYS.join(", ")}`);
  checkValue(name, value);
  if (name === RETIRING_TRANSCRIPTION_KEYS) keyringSecrets(name, value);
  const { secrets } = fillSecrets(inv, { ...await store.read() ?? { nodes: {} }, [name]: value });
  await store.write(secrets);
}
