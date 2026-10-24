import "@tanstack/react-start/server-only";
import { getRequest } from "@tanstack/react-start/server";
import type { NodeLatencies } from "@orbmeet/nodes";
import { logWarn } from "@/lib/logger";
import { mediaNodes, nodeHosts } from "./nodes";

/**
 * How far each node is from the person a request is for, in milliseconds,
 * when their browser did not say (see `browserNodeLatencies`).
 *
 * Cloudflare's anycast routing brings everyone to the data centre their
 * network reaches best, a few milliseconds away, and this Worker runs there.
 * The nodes are not on Cloudflare: from here, each is reached over the public
 * internet, so the time to open a connection to it from this data centre is,
 * near enough, the time from the person to it. That ranks nodes by the
 * network as it is, which no map can.
 */

/** Long enough that few requests measure; short enough that a moved or new node is seen soon. */
const CACHE_SECONDS = 600;
/** A node slower than this to accept a connection is as good as unreachable for a call. */
const PROBE_TIMEOUT_MS = 1_500;

/** Milliseconds to open a TCP connection to `host`:443, or undefined when it did not open in time. */
async function connectMs(host: string): Promise<number | undefined> {
  try {
    const { connect } = await import("cloudflare:sockets");
    const started = Date.now();
    const socket = connect({ hostname: host, port: 443 });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const opened = await Promise.race([
        socket.opened.then(() => true),
        new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), PROBE_TIMEOUT_MS); }),
      ]);
      // Workers advance the clock at I/O, so this spans the handshake.
      return opened ? Math.max(1, Date.now() - started) : undefined;
    } finally {
      clearTimeout(timer);
      socket.close().catch(() => {});
    }
  } catch {
    return undefined;
  }
}

export interface LatencyDeps {
  probe: (host: string) => Promise<number | undefined>;
  /** This data centre's cache; null where there is none (local development, tests). */
  cache: Cache | null;
}

const defaultDeps = (): LatencyDeps => ({
  probe: connectMs,
  cache: typeof caches === "undefined" ? null : (caches as unknown as { default: Cache }).default,
});

/**
 * Each node's latency from data centre `colo`, measured now or taken from
 * this data centre's cache. A node that did not answer is left out.
 */
export async function measureNodeLatencies(
  env: Pick<Env, "NODES">,
  colo: string,
  deps: LatencyDeps = defaultDeps(),
): Promise<NodeLatencies> {
  let hosts: ReadonlyMap<string, string>;
  try {
    hosts = nodeHosts(env);
  } catch {
    return {};
  }
  // A changed node list is a new key, so a replaced node is measured at once.
  const nodes = [...hosts].map(([id, host]) => `${id}=${host}`).sort().join(",");
  const key = new Request(`https://node-latency.internal/${encodeURIComponent(colo)}?${encodeURIComponent(nodes)}`);
  const cached = await deps.cache?.match(key).catch(() => undefined);
  if (cached) return await cached.json() as NodeLatencies;

  const measured = await Promise.all([...hosts].map(async ([id, host]) => [id, await deps.probe(host)] as const));
  const latencies = Object.fromEntries(measured.filter((entry): entry is [string, number] => entry[1] !== undefined));
  const missing = measured.filter(([, ms]) => ms === undefined).map(([id]) => id);
  if (missing.length > 0) logWarn("[nodes] Some nodes could not be reached", { colo, nodes: missing });
  await deps.cache?.put(key, Response.json(latencies, {
    headers: { "Cache-Control": `max-age=${CACHE_SECONDS}` },
  })).catch(() => {});
  return latencies;
}

/**
 * The latencies a browser measured to the media nodes, kept only for nodes
 * NODES lists; null when none remain. A browser could claim anything here, but
 * the claim only steers where its own meeting starts, among healthy nodes with
 * room.
 */
export function browserNodeLatencies(
  env: Pick<Env, "NODES">,
  reported: NodeLatencies | undefined,
): NodeLatencies | null {
  if (!reported) return null;
  let known: ReadonlyMap<string, unknown>;
  try {
    known = mediaNodes(env);
  } catch {
    return null;
  }
  const kept = Object.entries(reported).filter(([id]) => known.has(id));
  return kept.length > 0 ? Object.fromEntries(kept) : null;
}

/** `measureNodeLatencies` from the data centre serving the current request; none outside one. */
export async function currentNodeLatencies(env: Pick<Env, "NODES">): Promise<NodeLatencies> {
  let request: Request;
  try {
    request = getRequest();
  } catch {
    return {};
  }
  const colo = (request as Request & { cf?: { colo?: unknown } }).cf?.colo;
  return measureNodeLatencies(env, typeof colo === "string" ? colo : "local");
}
