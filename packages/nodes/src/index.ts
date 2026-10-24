import { parseKeyring, type Keyring } from "@orbmeet/primitives";
import * as v from "valibot";

/**
 * The self-hosted nodes, as both sides of the deployment see them.
 *
 * A node is one machine running some services (media: LiveKit with TURN,
 * Egress and transcription; whiteboard: the sync server) and sharing nothing
 * with other nodes. Nodes come and go: the operator lists them in
 * infra/ops/inventory.json, the deploy tool publishes them to the Worker as
 * NODES, and the Worker places every Meeting and board on one, by the
 * latency the user's browser measured to each (or, failing that, the latency
 * from the Cloudflare data centre the user came in through). Both sides parse
 * NODES with this module, name hosts with it, and place with it, so neither
 * can drift from the other.
 *
 * Nodes in one region (two machines in Singapore, say) are interchangeable:
 * whoever is fastest to one of them is served as well by any of them, and
 * load decides between them.
 */

/**
 * Nodes whose latency is within this much of the fastest count as equally
 * near, as every node in the fastest node's region does.
 */
export const NEAR_MS = 30;

/** Milliseconds from someone to each node, by node id; a node not measured is absent. */
export type NodeLatencies = Readonly<Record<string, number>>;

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/**
 * A node's public names under the app's domain. The deploy tool points DNS
 * at them and Caddy holds their certificates; the Worker hands them to
 * clients and admits them in its CSP.
 */
export function nodeHostnames(domain: string, id: string): { rtc: string; turn: string; whiteboard: string } {
  return { rtc: `${id}.rtc.${domain}`, turn: `${id}.turn.${domain}`, whiteboard: `${id}.whiteboard.${domain}` };
}

/** Every node's whiteboard name at once: the CSP source that admits them all, including nodes added later. */
export function whiteboardHostWildcard(domain: string): string {
  return `*.whiteboard.${domain}`;
}

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

export interface PlacementCandidate {
  id: string;
  /** Relative share of new work among nodes about equally near; 0 takes none, to retire the node. */
  weight: number;
  /** Nodes sharing a region are equally near to anyone; absent, the node is a region of its own. */
  region?: string;
}

export interface PlacementOptions<T> {
  /**
   * Milliseconds from whoever the work is for to the node, or undefined where
   * it was not measured. Without any, every candidate is equally near.
   */
  latency?: (node: T) => number | undefined;
  /** What the node carries now, in the unit `capacity` is in. */
  load?: (node: T) => number;
  /** What the node can carry; a node at capacity takes new work only when every node is. */
  capacity?: (node: T) => number;
  /** Spreads exact ties across nodes, deterministically for the same key: a board's id, say. */
  spreadKey?: string;
}

function hash(text: string): number {
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) value = Math.imul(value ^ text.charCodeAt(index), 0x01000193);
  return value >>> 0;
}

/**
 * The candidates nearest by latency: those in the fastest one's region, and
 * any within NEAR_MS of it. A candidate not measured while others were is left
 * out, since it did not answer; with no measurements at all, every candidate
 * is near.
 */
export function nearestByLatency<T extends { id: string; region?: string }>(
  candidates: readonly T[],
  latency: (node: T) => number | undefined,
): T[] {
  const measured = candidates.filter((node) => latency(node) !== undefined);
  if (measured.length === 0) return [...candidates];
  const fastest = measured.reduce((best, node) => (latency(node)! < latency(best)! ? node : best));
  const region = regionOf(fastest);
  return measured.filter((node) => regionOf(node) === region || latency(node)! <= latency(fastest)! + NEAR_MS);
}

function regionOf(node: { id: string; region?: string }): string {
  return node.region ?? node.id;
}

/**
 * The node new work goes to, from candidates already known to be up.
 *
 * Candidates that take new work (weight above 0) and have room come first;
 * then those that take new work; then any, so work is never refused while a
 * node answers. Of the first nonempty tier, the nodes nearest by latency, and
 * of those the one with the lowest load for its weight; then the faster, the
 * heavier, and a hash of `spreadKey`.
 */
export function placeNode<T extends PlacementCandidate>(
  candidates: readonly T[],
  { latency = () => undefined, load, capacity, spreadKey = "" }: PlacementOptions<T>,
): T | null {
  const hasRoom = (node: T) => !load || !capacity || load(node) < capacity(node);
  const tiers = [
    candidates.filter((node) => node.weight > 0 && hasRoom(node)),
    candidates.filter((node) => node.weight > 0),
    candidates,
  ];
  const pool = tiers.find((tier) => tier.length > 0);
  if (!pool) return null;
  const near = nearestByLatency(pool, latency);
  const score = (node: T) => (load ? load(node) : 0) / Math.max(node.weight, 1);
  const rank = (node: T) => [score(node), latency(node) ?? 0, -node.weight, hash(`${spreadKey}/${node.id}`)];
  return near.reduce((best, node) => {
    const [a, b] = [rank(node), rank(best)];
    const first = a.findIndex((value, index) => value !== b[index]);
    return first !== -1 && a[first] < b[first] ? node : best;
  });
}

// ---------------------------------------------------------------------------
// NODES
// ---------------------------------------------------------------------------

export interface MediaService {
  /** Signalling URL handed to clients: wss:// in production, ws:// locally. */
  url: string;
  /** Live participants plus open Meetings the node carries before new Meetings go elsewhere. */
  capacity: number;
  /** The key the Worker signs tokens and API calls with: the first entry of the node's keyring. */
  apiKey: string;
  apiSecret: string;
}

export interface WhiteboardService {
  /** The sync server's origin: https:// in production, http:// locally. */
  url: string;
  /** Signs the whiteboard tokens the Worker mints for this node; the first key signs. */
  jwtKeyring: Keyring;
  /** Signs the Worker's commands to this node; the first key signs. */
  commandKeyring: Keyring;
  /** Verifies this node's calls to the Worker. */
  callbackKeyring: Keyring;
}

export interface Node {
  id: string;
  /** Where the node is; nodes in one region are interchangeable. The node's own id when NODES names none. */
  region: string;
  /** Relative share of new work among nodes about equally near; 0 keeps the node's work but sends it none, to retire it. */
  weight: number;
  media: MediaService | null;
  whiteboard: WhiteboardService | null;
}

export interface NodeConfig {
  nodes: ReadonlyMap<string, Node>;
  /** Every node's LiveKit keys, by key id: a webhook names its node by the key it is signed with. */
  liveKitKeys: ReadonlyMap<string, { node: Node; secret: string }>;
  /** Every node's whiteboard token keys, by key id: a token names the node it was minted for. */
  whiteboardJwtKeys: ReadonlyMap<string, { node: Node; secret: string }>;
  /** Every node's callback keys as one keyring, which verifies any node's call to the Worker. */
  whiteboardCallbackKeyring: Keyring;
  /** The node each callback key belongs to: a call names its node by the key it is signed with. */
  whiteboardCallbackNodes: ReadonlyMap<string, Node>;
}

const NODE_ID = /^[a-z][a-z0-9-]{0,30}$/;
/** A region's name, such as `sin` or `ams`. */
const REGION = /^[a-z][a-z0-9-]{0,30}$/;
const MAX_NODES = 16;
export const MAX_KEYRING_KEYS = 4;

/**
 * Whether a key id keeps its written place in a keyring. JavaScript orders an
 * object's integer-like keys ahead of every other, whatever order they were
 * written in, so a numeric id would silently become the first key: the one
 * that signs.
 */
export function keepsKeyringOrder(keyId: string): boolean {
  return !/^(?:0|[1-9][0-9]*)$/.test(keyId);
}

const KEYRING_SIZE = `must hold between 1 and ${MAX_KEYRING_KEYS} keys`;
const KEYRING_ORDER = "must not use plain numbers as key ids, which would move them to the front of the keyring";

// A node's LiveKit keyring. Keys are used in both directions (the Worker
// signs tokens and API calls, the node signs webhooks), so a rotation adds the
// new key second, promotes it once both sides hold it, and drops the old key
// last. The first key is the one that signs.
const LiveKitKeyringSchema = v.pipe(
  v.record(
    v.pipe(v.string(), v.nonEmpty(), v.maxLength(128)),
    v.pipe(v.string(), v.nonEmpty(), v.maxLength(512)),
  ),
  v.check((keys) => Object.keys(keys).every(keepsKeyringOrder), KEYRING_ORDER),
  v.check((keys) => Object.keys(keys).length > 0 && Object.keys(keys).length <= MAX_KEYRING_KEYS, KEYRING_SIZE),
);

// The whiteboard's keyrings have the service-to-service shape of
// @orbmeet/primitives' signed requests: key ids to secrets of 32-512 characters.
const WhiteboardKeyringSchema = v.pipe(
  v.record(v.string(), v.string()),
  v.check((keys) => Object.keys(keys).every(keepsKeyringOrder), KEYRING_ORDER),
  v.check((keys) => Object.keys(keys).length > 0 && Object.keys(keys).length <= MAX_KEYRING_KEYS, KEYRING_SIZE),
  v.check((keys) => parseKeyring(JSON.stringify(keys)) !== null,
    "must map key ids of letters, digits, '-' and '_' to secrets of 32-512 characters"),
  v.transform((keys) => parseKeyring(JSON.stringify(keys))!),
);

const origin = (protocols: string, message: string) => v.pipe(
  v.string(),
  v.url(),
  v.check((url) => new RegExp(`^(?:${protocols})://[^/?#]+/?$`).test(url), message),
  v.transform((url) => url.replace(/\/$/, "")),
);

const NodeSchema = v.pipe(
  v.strictObject({
    region: v.optional(v.pipe(v.string(), v.regex(REGION))),
    weight: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(100)), 1),
    media: v.optional(v.strictObject({
      url: origin("wss?", "must be a ws:// or wss:// origin"),
      capacity: v.pipe(v.number(), v.integer(), v.minValue(1)),
      keys: LiveKitKeyringSchema,
    })),
    whiteboard: v.optional(v.strictObject({
      url: origin("https?", "must be an http:// or https:// origin"),
      jwt: WhiteboardKeyringSchema,
      command: WhiteboardKeyringSchema,
      callback: WhiteboardKeyringSchema,
    })),
  }),
  v.check((node) => node.media !== undefined || node.whiteboard !== undefined, "must run media, the whiteboard or both"),
);

/** Whether every key id across these keyrings is distinct: a key names the node that holds it. */
const distinctKeyIds = (keyrings: Iterable<Iterable<string>>) => {
  const ids = [...keyrings].flatMap((keyring) => [...keyring]);
  return new Set(ids).size === ids.length;
};

const NodesSchema = v.pipe(
  v.record(v.pipe(v.string(), v.regex(NODE_ID)), NodeSchema),
  v.check((nodes) => {
    const count = Object.keys(nodes).length;
    return count > 0 && count <= MAX_NODES;
  }, `must list between 1 and ${MAX_NODES} nodes`),
  v.check((nodes) => distinctKeyIds(Object.values(nodes).map((node) => Object.keys(node.media?.keys ?? {}))),
    "every LiveKit key id must be unique across nodes"),
  v.check((nodes) => distinctKeyIds(Object.values(nodes).map((node) => node.whiteboard?.jwt.keys() ?? [])),
    "every whiteboard token key id must be unique across nodes"),
  v.check((nodes) => distinctKeyIds(Object.values(nodes).map((node) => node.whiteboard?.callback.keys() ?? [])),
    "every whiteboard callback key id must be unique across nodes"),
  v.transform((config): NodeConfig => {
    const nodes = new Map<string, Node>();
    const liveKitKeys = new Map<string, { node: Node; secret: string }>();
    const whiteboardJwtKeys = new Map<string, { node: Node; secret: string }>();
    const whiteboardCallbackKeyring = new Map<string, string>();
    const whiteboardCallbackNodes = new Map<string, Node>();
    for (const [id, { region, weight, media, whiteboard }] of Object.entries(config)) {
      const keys = media ? Object.entries(media.keys) : [];
      const node: Node = {
        id,
        region: region ?? id,
        weight,
        media: media
          ? { url: media.url, capacity: media.capacity, apiKey: keys[0][0], apiSecret: keys[0][1] }
          : null,
        whiteboard: whiteboard
          ? {
              url: whiteboard.url,
              jwtKeyring: whiteboard.jwt,
              commandKeyring: whiteboard.command,
              callbackKeyring: whiteboard.callback,
            }
          : null,
      };
      nodes.set(id, node);
      for (const [keyId, secret] of keys) liveKitKeys.set(keyId, { node, secret });
      for (const [keyId, secret] of whiteboard?.jwt ?? []) whiteboardJwtKeys.set(keyId, { node, secret });
      for (const [keyId, secret] of whiteboard?.callback ?? []) {
        whiteboardCallbackKeyring.set(keyId, secret);
        whiteboardCallbackNodes.set(keyId, node);
      }
    }
    return { nodes, liveKitKeys, whiteboardJwtKeys, whiteboardCallbackKeyring, whiteboardCallbackNodes };
  }),
);

/**
 * What the deploy tool publishes:
 * `{"sg1": {"region": "sin", "weight": 1,
 *   "media": {"url": "wss://…", "capacity": 60, "keys": {"<id>": "<secret>"}},
 *   "whiteboard": {"url": "https://…", "jwt": {…}, "command": {…}, "callback": {…}}}}`.
 */
export type NodesInput = v.InferInput<typeof NodesSchema>;

/**
 * Parse a serialized NODES. Throws on a missing or malformed value; the
 * message names where it failed and what was expected, never the value,
 * since the value carries secrets.
 */
export function parseNodes(serialized: string): NodeConfig {
  let json: unknown;
  try {
    json = JSON.parse(serialized);
  } catch {
    throw new Error("NODES is missing or is not JSON");
  }
  const parsed = v.safeParse(NodesSchema, json);
  if (!parsed.success) {
    // Valibot's messages quote the received input, so build our own.
    const [issue] = parsed.issues;
    const path = v.getDotPath(issue);
    const expected = issue.type === "check" ? issue.message : `expected ${issue.expected}`;
    throw new Error(`NODES is invalid${path ? ` at ${path}` : ""}: ${expected}`);
  }
  return parsed.output;
}
