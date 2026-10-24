import { parseNodes, type NodeConfig } from "@orbmeet/nodes";
import type { Keyring } from "@orbmeet/primitives";

// The self-hosted nodes, from the NODES secret the deploy tool publishes; see
// @orbmeet/nodes, whose schema both sides read it with. Each service has its
// own view of a node: a Meeting needs its LiveKit, a board its sync server.

/** A node's LiveKit: where a Meeting's room is. */
export interface MediaNode {
  id: string;
  /** Media nodes in one region serve the same people equally well. */
  region: string;
  weight: number;
  /** Signalling URL handed to clients: wss:// in production, ws:// locally. */
  url: string;
  /** Live participants plus open Meetings it carries before new Meetings go elsewhere. */
  capacity: number;
  /** The key the Worker signs with: the first entry of the node's keyring. */
  apiKey: string;
  apiSecret: string;
}

/** A node's whiteboard sync server: where a board is. */
export interface WhiteboardNode {
  id: string;
  region: string;
  weight: number;
  /** The sync server's origin: https:// in production, http:// locally. */
  whiteboardUrl: string;
  /** Signs the tokens minted for this node. */
  jwtKeyring: Keyring;
  /** Signs the Worker's commands to this node. */
  commandKeyring: Keyring;
}

interface Views {
  config: NodeConfig;
  media: ReadonlyMap<string, MediaNode>;
  whiteboard: ReadonlyMap<string, WhiteboardNode>;
  /** A public name of each node's machine, by node id: where its latency is measured to. */
  hosts: ReadonlyMap<string, string>;
  /** Every node's token keys as one keyring, which verifies a token minted for any node. */
  whiteboardJwtKeyring: Keyring;
}

let cached: { serialized: string; views: Views } | null = null;

function views(env: Pick<Env, "NODES">): Views {
  const serialized = env.NODES ?? "";
  if (cached?.serialized === serialized) return cached.views;
  const config = parseNodes(serialized);
  const media = new Map<string, MediaNode>();
  const whiteboard = new Map<string, WhiteboardNode>();
  const hosts = new Map<string, string>();
  for (const { id, region, weight, media: m, whiteboard: w } of config.nodes.values()) {
    if (m) media.set(id, { id, region, weight, url: m.url, capacity: m.capacity, apiKey: m.apiKey, apiSecret: m.apiSecret });
    if (w) {
      whiteboard.set(id, {
        id, region, weight, whiteboardUrl: w.url, jwtKeyring: w.jwtKeyring, commandKeyring: w.commandKeyring,
      });
    }
    hosts.set(id, new URL((m ?? w)!.url).hostname);
  }
  const whiteboardJwtKeyring = new Map([...config.whiteboardJwtKeys].map(([keyId, { secret }]) => [keyId, secret]));
  const built = { config, media, whiteboard, hosts, whiteboardJwtKeyring };
  cached = { serialized, views: built };
  return built;
}

/**
 * The nodes running LiveKit, keyed by id. Throws on a missing or malformed
 * NODES; that is a deployment error, not a condition to degrade around.
 */
export function mediaNodes(env: Pick<Env, "NODES">): ReadonlyMap<string, MediaNode> {
  return views(env).media;
}

/** The nodes running a whiteboard sync server, keyed by id. Throws as `mediaNodes` does. */
export function whiteboardNodes(env: Pick<Env, "NODES">): ReadonlyMap<string, WhiteboardNode> {
  return views(env).whiteboard;
}

/** A public name of each node's machine, by node id. Throws as `mediaNodes` does. */
export function nodeHosts(env: Pick<Env, "NODES">): ReadonlyMap<string, string> {
  return views(env).hosts;
}

/**
 * The media node that owns a LiveKit API key id, with that key's secret, for
 * verifying a webhook the node signed. Null for a key no node holds.
 */
export function mediaNodeKey(
  env: Pick<Env, "NODES">,
  keyId: string,
): { node: MediaNode; secret: string } | null {
  const key = views(env).config.liveKitKeys.get(keyId);
  const node = key && views(env).media.get(key.node.id);
  return key && node ? { node, secret: key.secret } : null;
}

/** Every node's whiteboard token keys: verifies a token the Worker minted for any node. */
export function whiteboardJwtKeyring(env: Pick<Env, "NODES">): Keyring {
  return views(env).whiteboardJwtKeyring;
}

/** Every node's callback keys: verifies a call from any node's sync server. */
export function whiteboardCallbackKeyring(env: Pick<Env, "NODES">): Keyring {
  return views(env).config.whiteboardCallbackKeyring;
}

/** The node whose sync server signs with this callback key. */
export function whiteboardCallbackNodeId(env: Pick<Env, "NODES">, keyId: string): string | null {
  return views(env).config.whiteboardCallbackNodes.get(keyId)?.id ?? null;
}

/** Where a browser measures its latency to a media node: what answers at the root of its signalling origin. */
export interface MediaNodeProbe {
  id: string;
  url: string;
}

/**
 * Each media node's probe URL: LiveKit answers `GET /` itself, on the origin
 * the meet-route CSP already admits. Empty when the configuration is unusable,
 * and the Worker then measures from its data centre instead.
 */
export function mediaNodeProbes(env: Pick<Env, "NODES">): MediaNodeProbe[] {
  try {
    return [...mediaNodes(env).values()].map((node) => {
      const url = new URL(node.url);
      url.protocol = url.protocol === "wss:" ? "https:" : "http:";
      return { id: node.id, url: url.origin + "/" };
    });
  } catch {
    return [];
  }
}

/**
 * Hosts of every media node, for the meet-route CSP. Empty when the
 * configuration is unusable: the pages still render, and joining reports the
 * configuration error.
 */
export function mediaNodeHosts(env: Pick<Env, "NODES">): string[] {
  try {
    return [...mediaNodes(env).values()].map((node) => new URL(node.url).host);
  } catch {
    return [];
  }
}
