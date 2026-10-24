import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** The repository, this package, and what is shipped to the nodes. */
export const ROOT = resolve(import.meta.dirname, "../../..");
export const OPS = join(ROOT, "infra/ops");
export const NODE_DIR = join(OPS, "node");
/** Operator-local state that is only a cache: rendered node files and publish stamps. */
export const LOCAL = join(ROOT, ".local/ops");
/** Where each node keeps the source it builds from. */
export const REMOTE = "/opt/orbmeet/source";
export const REMOTE_NODE_DIR = `${REMOTE}/infra/ops/node`;

/** The encrypted secrets, the public keys that may read them, and this operator's private key. */
export const SECRETS_FILE = join(OPS, "secrets.age");
export const RECIPIENTS_FILE = join(OPS, "age-recipients.txt");
export const AGE_IDENTITY = process.env.ORBMEET_AGE_KEY ?? join(homedir(), ".config/orbmeet/age.key");

// Upstream livekit/egress v1.14.1's chrome-sandboxing-seccomp-profile.json. The
// checked-in copy is the vendor's policy verbatim; a local edit is a change to
// what Chrome's sandbox is permitted to do and must be a deliberate revendoring.
export const EGRESS_SECCOMP_SHA256 = "53fb08509c52e0ae6a6c08130136b24f69553cafb11b59cf12c251e2ee25af4a";

/**
 * The whiteboard assistant's model, as `<provider>/<model id>`. It runs only
 * once AI_API_KEY, that provider's key, is set with `set-secret`.
 */
export const ASSISTANT_MODEL = "google/gemini-3.8-flash";

/** The Axiom dataset nodes send their logs to: the Worker's, so one query covers both. */
export const AXIOM_DATASET = "orbmeet";

// Container addresses pinned in node/compose.yaml, on the one bridge every
// container but Caddy and LiveKit (which use the host's network) is on. The
// host is its gateway: LiveKit binds its API there, for Caddy on the host and
// the transcription agent on the bridge.
export const BRIDGE_SUBNET = "172.30.22.0/28";
export const GATEWAY = "172.30.22.1";
export const WHITEBOARD = "172.30.22.3";
export const REDIS = "172.30.22.10";
export const EGRESS = "172.30.22.11";
export const TRANSCRIPTION = "172.30.22.12";

// What no container may reach: private, loopback, link-local (cloud metadata),
// shared, documentation, benchmarking, multicast and reserved ranges.
export const PRIVATE_DESTINATIONS = [
  "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12",
  "192.0.0.0/24", "192.0.2.0/24", "192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24",
  "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4",
];

/**
 * The inventory's services and the Compose services each one runs. Every
 * Compose service has a profile of its own name.
 */
export const SERVICES = {
  // Every media node transcribes its own rooms: an agent registers with one
  // LiveKit server, and nodes share nothing.
  media: ["caddy", "livekit", "redis", "egress", "transcription"],
  // Served by the node's Caddy at its whiteboard name, beside its media: the
  // Worker sends each board to one node, and its clients to that node's name.
  whiteboard: ["caddy", "whiteboard"],
} as const;
export type Service = keyof typeof SERVICES;
export type Container = (typeof SERVICES)[Service][number];
export const SERVICE_NAMES = Object.keys(SERVICES) as Service[];

export const PUBLIC_PORTS: Record<Service, { tcp: string[]; udp: string[] }> = {
  media: { tcp: ["80", "443", "7881"], udp: ["443", "7882:7885"] },
  whiteboard: { tcp: ["80", "443"], udp: [] },
};

/**
 * Each container's memory limit unless the node's inventory says otherwise:
 * sized for a node of about 16 GB. A node's limits, with HOST_MEMORY_RESERVE,
 * must fit in its memory, so no container can starve LiveKit of it.
 */
export const MEMORY_LIMITS = {
  caddy: "256m", livekit: "4g", redis: "512m", egress: "4g", transcription: "2g", whiteboard: "2g",
} as const satisfies Record<Container, string>;

/** What the host keeps for itself, Docker and the page cache. */
export const HOST_MEMORY_RESERVE = "512m";

/** Ports that must never answer at a node's public address. */
export const INTERNAL_PORTS = [111, 2019, 5350, 6379, 6789, 7880, 8787, 9090, 9091];

/** Images built on the nodes, by Compose service. */
export const DOCKERFILES = {
  whiteboard: "apps/whiteboard-server/Dockerfile",
  transcription: "apps/transcription-agent/Dockerfile",
} as const;

/** Workspace files every image build reads besides its own sources: what nodes are sent. */
export const WORKSPACE_FILES = ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.base.json", ".dockerignore"];

/**
 * The workspace files a build's digest hashes whole. The lockfile and the
 * root package.json are hashed only in the part a build reads (render.ts
 * `buildDigest`), and pnpm-workspace.yaml's catalog and overrides show up
 * there as the versions they resolved to.
 */
export const BUILD_FILES = ["tsconfig.base.json", ".dockerignore"];
