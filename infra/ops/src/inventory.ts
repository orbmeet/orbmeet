import { isIPv4, isIPv6 } from "node:net";
import { isRecord } from "@orbmeet/primitives";
import {
  HOST_MEMORY_RESERVE, MEMORY_LIMITS, SERVICE_NAMES, SERVICES, type Container, type Service,
} from "./catalog.ts";
import { OpsError } from "./shell.ts";

interface Node {
  /** user@host for ssh and rsync. */
  ssh: string;
  ipv4: string;
  ipv6: string | null;
  /** The public interface LiveKit binds its media to. */
  interface: string;
  services: Service[];
  /** The Compose services those services run, in catalog order. */
  containers: Container[];
  /** Where the node is, such as sin or ams: nodes in one region serve the same people. The node's name when none is given. */
  region: string;
  /** Relative share of new Meetings among nodes about equally near; 0 keeps the node's Meetings but sends it no new ones. */
  weight: number;
  /** Live participants plus open Meetings its LiveKit carries before new Meetings go to other nodes; null without media. */
  mediaCapacity: number | null;
  /** Each container's memory limit, from MEMORY_LIMITS and the node's own `memory_limits`. */
  memoryLimits: Record<Container, string>;
}

export interface Inventory {
  appUrl: string;
  domain: string;
  nodes: Record<string, Node>;
}

const NODE_KEYS = new Set(["ssh", "ipv4", "ipv6", "interface", "services", "region", "weight", "memory",
  "media_capacity", "memory_limits"]);

const LABEL = /^[a-z][a-z0-9-]{0,30}$/;
const SSH_TARGET = /^[A-Za-z0-9_][A-Za-z0-9_.@-]*$/;
const INTERFACE_NAME = /^[a-zA-Z0-9_.:-]{1,15}$/;
const MEMORY = /^[1-9][0-9]*[mg]$/;

/** A Docker memory size such as 3g or 512m, in MiB. */
export function mebibytes(size: string): number {
  return Number(size.slice(0, -1)) * (size.endsWith("g") ? 1024 : 1);
}

function requireString(value: unknown, pattern: RegExp, message: string): string {
  if (typeof value !== "string" || !pattern.test(value)) throw new OpsError(message);
  return value;
}

/** Validate inventory.json and fill in per-node defaults. */
export function loadInventory(data: unknown): Inventory {
  if (!isRecord(data) || !isRecord(data.nodes) || Object.keys(data.nodes).length === 0) {
    throw new OpsError('inventory.json needs a nonempty "nodes" object');
  }
  const unknown = Object.keys(data).filter((key) => key !== "app_url" && key !== "nodes");
  if (unknown.length) throw new OpsError(`inventory.json: unknown keys ${unknown.join(", ")}`);
  const appUrl = requireString(
    data.app_url,
    /^https:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)$/,
    "app_url must be an HTTPS origin without a trailing slash",
  );
  const domain = appUrl.slice("https://".length);

  const nodes: Record<string, Node> = {};
  for (const [name, node] of Object.entries(data.nodes)) {
    // The name is a DNS label in the node's hostnames and a NODES id.
    requireString(name, LABEL, `Node name ${JSON.stringify(name)} must be lowercase letters, digits and hyphens`);
    if (!isRecord(node)) throw new OpsError(`${name}: expected an object`);
    const extra = Object.keys(node).filter((key) => !NODE_KEYS.has(key));
    if (extra.length) throw new OpsError(`${name}: unknown keys ${extra.sort().join(", ")}`);
    const n: Record<string, unknown> = { ipv6: null, region: name, weight: 1, memory_limits: {}, ...node };
    // Passed to ssh and rsync as the destination; a leading '-' would be an option.
    const ssh = requireString(n.ssh, SSH_TARGET, `${name}: ssh must be user@host`);
    if (typeof n.ipv4 !== "string" || !isIPv4(n.ipv4)
        || (n.ipv6 !== null && (typeof n.ipv6 !== "string" || !isIPv6(n.ipv6)))) {
      throw new OpsError(`${name}: ipv4 and ipv6 must be addresses`);
    }
    const iface = requireString(n.interface, INTERFACE_NAME, `${name}: interface must be a network interface name`);
    const services = n.services;
    if (!Array.isArray(services) || services.length === 0 || new Set(services).size !== services.length
        || services.some((s) => !SERVICE_NAMES.includes(s))) {
      throw new OpsError(`${name}: services must list distinct services from ${SERVICE_NAMES.join(", ")}`);
    }
    const region = requireString(
      n.region,
      LABEL,
      `${name}: region must be lowercase letters, digits and hyphens, like sin or ams`,
    );
    if (typeof n.weight !== "number" || !Number.isInteger(n.weight) || n.weight < 0 || n.weight > 100) {
      throw new OpsError(`${name}: weight must be an integer from 0 to 100`);
    }
    const ordered = SERVICE_NAMES.filter((s) => services.includes(s));
    const containers = [...new Set(ordered.flatMap((s) => SERVICES[s]))];
    const media = ordered.includes("media");
    if (media !== (n.media_capacity !== undefined)
        || (media && (!Number.isInteger(n.media_capacity) || (n.media_capacity as number) < 1))) {
      throw new OpsError(`${name}: media_capacity is a positive integer, given exactly when the node runs media`);
    }
    // `free -m`'s total: what the containers' limits must fit in.
    const memory = requireString(
      n.memory,
      MEMORY,
      `${name}: memory must be the machine's memory, like 11885m (free -m's total) or 16g`,
    );
    const overrides = n.memory_limits;
    if (!isRecord(overrides) || Object.entries(overrides).some(([container, size]) =>
      !(containers as string[]).includes(container) || typeof size !== "string" || !MEMORY.test(size))) {
      throw new OpsError(`${name}: memory_limits maps containers it runs (${containers.join(", ")}) to sizes like 3g or 512m`);
    }
    const memoryLimits = { ...MEMORY_LIMITS, ...overrides } as Record<Container, string>;
    const budget = mebibytes(memory) - mebibytes(HOST_MEMORY_RESERVE);
    const total = containers.reduce((sum, container) => sum + mebibytes(memoryLimits[container]), 0);
    if (total > budget) {
      throw new OpsError(`${name}: its containers' memory limits total ${total}m, more than the ${budget}m its ${memory} `
        + `leaves after the host's ${HOST_MEMORY_RESERVE}; lower some in memory_limits (${containers
          .map((container) => `${container} ${memoryLimits[container]}`).join(", ")})`);
    }
    nodes[name] = {
      ssh,
      ipv4: n.ipv4,
      // The canonical (RFC 5952) form, as DNS answers print it.
      ipv6: n.ipv6 === null ? null : new URL(`http://[${n.ipv6}]`).hostname.slice(1, -1),
      interface: iface,
      services: ordered,
      containers,
      region,
      weight: n.weight,
      mediaCapacity: media ? n.media_capacity as number : null,
      memoryLimits: Object.fromEntries(containers.map((c) => [c, memoryLimits[c]])) as Record<Container, string>,
    };
  }
  const all = Object.values(nodes);
  if (new Set(all.map((n) => n.ipv4)).size !== all.length) throw new OpsError("Each node needs a distinct ipv4");
  if (!all.some((n) => n.services.includes("media") && n.weight > 0)) {
    throw new OpsError("At least one media node must have a nonzero weight");
  }
  // The whiteboard is reached through the node's Caddy, which media sets up.
  const bare = Object.keys(nodes).filter((name) => nodes[name].services.includes("whiteboard")
    && !nodes[name].services.includes("media"));
  if (bare.length) throw new OpsError(`${bare.join(", ")}: whiteboard runs only beside media`);
  return { appUrl, domain, nodes };
}

export function whiteboardNodes(inv: Inventory): string[] {
  return Object.keys(inv.nodes).filter((name) => inv.nodes[name].services.includes("whiteboard"));
}

export function mediaNodes(inv: Inventory): string[] {
  return Object.keys(inv.nodes).filter((name) => inv.nodes[name].services.includes("media"));
}
