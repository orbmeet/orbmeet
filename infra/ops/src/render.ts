import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { parseNodes, type NodesInput } from "@orbmeet/nodes";
import {
  ASSISTANT_MODEL, AXIOM_DATASET, BRIDGE_SUBNET, BUILD_FILES, DOCKERFILES, EGRESS, EGRESS_SECCOMP_SHA256, GATEWAY,
  NODE_DIR, PRIVATE_DESTINATIONS, PUBLIC_PORTS, REDIS, ROOT, TRANSCRIPTION, WHITEBOARD,
} from "./catalog.ts";
import { mebibytes, rtcHost, turnHost, whiteboardHost, type Inventory } from "./inventory.ts";
import { lockfileSlice } from "./lockfile.ts";
import {
  AI_KEY, DEEPGRAM_KEY, R2_KEYS, signingKey, WHITEBOARD_KEYRINGS, type Secrets,
} from "./secrets.ts";
import { OpsError } from "./shell.ts";

/** Write a file that is never readable by others while it holds a secret, whatever the umask. */
export function writePrivate(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, value, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** Content hash of files, keyed by their paths relative to `base` (the repository). */
export function digest(paths: readonly string[], base = ROOT): string {
  const entries = paths.map((path) => ({ path, parts: relative(base, path).split(sep) }));
  // Ordered by path components, so a directory's files stay together.
  entries.sort((a, b) => {
    for (let i = 0; i < Math.min(a.parts.length, b.parts.length); i++) {
      if (a.parts[i] !== b.parts[i]) return a.parts[i] < b.parts[i] ? -1 : 1;
    }
    return a.parts.length - b.parts.length;
  });
  const hash = createHash("sha256");
  for (const { path, parts } of entries) {
    hash.update(parts.join("/"));
    hash.update(readFileSync(path));
  }
  return hash.digest("hex").slice(0, 24);
}

/** A directory's production files: no dependencies, build output or tests, so test-only changes keep image tags. */
export function productionFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!["node_modules", "dist", "__pycache__", ".git"].includes(entry.name)) files.push(...productionFiles(path));
    } else if (!/^(\.env|\.dev\.vars|test_)/.test(entry.name) && !/\.(test|spec)\.ts$/.test(entry.name)
        && entry.name !== ".DS_Store") {
      files.push(path);
    }
  }
  return files;
}

/**
 * The workspace directories an image's Dockerfile COPYs whole: what nodes are
 * sent and what its tag hashes. Read from the Dockerfile, so the two cannot drift.
 */
export function imageSources(service: keyof typeof DOCKERFILES): string[] {
  const dockerfile = readFileSync(join(ROOT, DOCKERFILES[service]), "utf8");
  return [...dockerfile.matchAll(/^COPY ((?:apps|packages)\/[a-z0-9-]+) \.\/\1$/gm)].map((match) => match[1]);
}

/**
 * A digest of what a build of these workspace directories reads: their
 * production files, the shared TypeScript and Docker configuration, the pnpm
 * that installs them, and their slice of the lockfile.
 */
function buildDigest(directories: readonly string[], options: { prod: boolean }): string {
  const files = digest([...BUILD_FILES.map((p) => join(ROOT, p)),
    ...directories.flatMap((dir) => productionFiles(join(ROOT, dir)))]);
  const { packageManager } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { packageManager: string };
  const lock = lockfileSlice(readFileSync(join(ROOT, "pnpm-lock.yaml"), "utf8"), directories, options);
  return createHash("sha256").update(files).update(packageManager).update(lock).digest("hex").slice(0, 24);
}

/** The tag of an image built on the nodes. */
function imageBuild(service: keyof typeof DOCKERFILES): string {
  const dockerfile = readFileSync(join(ROOT, DOCKERFILES[service]), "utf8");
  return buildDigest(imageSources(service), { prod: /pnpm install .*--prod/.test(dockerfile) });
}

/** Python's shlex.quote, which host.env is written for: health.sh and ship-logs.sh source it. */
function shellQuote(value: string): string {
  if (value === "") return "''";
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'"'"'`)}'`;
}

/**
 * iptables-restore input for the node's ORBMEET chains, by IP version.
 *
 * firewall.sh applies each with --noflush, so only these chains are replaced;
 * Docker's and the cloud image's own rules stay as they are.
 *
 * Caddy and LiveKit are on the host's network, so every public port is
 * INPUT; no container publishes a port. The containers share one bridge,
 * from which they may reach only what each needs.
 */
export function firewallRules(inv: Inventory, name: string): { v4: string; v6: string } {
  const node = inv.nodes[name];
  const { containers, interface: iface } = node;
  const ports = (protocol: "tcp" | "udp") => [...new Set(node.services.flatMap((s) => PUBLIC_PORTS[s][protocol]))]
    .sort((a, b) => Number(a.split(":")[0]) - Number(b.split(":")[0]));
  const tcp = ports("tcp");
  const udp = ports("udp");
  const runs = (container: string) => (containers as string[]).includes(container);
  const publicRules = [
    "-p tcp --dport 22 -j ACCEPT",
    ...(tcp.length ? [`-p tcp -m multiport --dports ${tcp.join(",")} -j ACCEPT`] : []),
    ...(udp.length ? [`-p udp -m multiport --dports ${udp.join(",")} -j ACCEPT`] : []),
    "-j DROP",
  ];
  // The recorder Chrome in Egress and the transcription agent join their own
  // node's rooms as any client does. The agent signals at LiveKit's API on
  // the gateway; Egress at the node's public name, since the recorder page
  // it loads over HTTPS cannot open plain ws://. Either's media and TURN go
  // to the node's addresses, which arrive here from the bridge when they are
  // the host's own (a node behind 1:1 NAT routes them through its provider).
  const clients = ([[EGRESS, "egress"], [TRANSCRIPTION, "transcription"]] as const)
    .filter(([, service]) => runs("livekit") && runs(service)).map(([client]) => client);
  const inputV4 = [
    "-i lo -j ACCEPT",
    "-m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT",
    ...clients.flatMap((client) => [
      `-i om-bridge -s ${client} -p tcp -m multiport --dports 443,7880,7881 -j ACCEPT`,
      `-i om-bridge -s ${client} -p udp -m multiport --dports 443,7882:7885 -j ACCEPT`,
    ]),
    // Containers may not probe the host, including metadata-proxy services.
    "-i om-+ -j DROP",
    "-p icmp -j ACCEPT",
    "-p udp --sport 67 --dport 68 -j ACCEPT",
    ...publicRules,
  ];
  const inputV6 = [
    "-i lo -j ACCEPT",
    "-m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT",
    "-i om-+ -j DROP",
    // Includes neighbour discovery and path MTU discovery.
    "-p ipv6-icmp -j ACCEPT",
    "-p udp --sport 547 --dport 546 -j ACCEPT",
    ...publicRules,
  ];
  // The bridge is IPv4-only; public IPv6 terminates at the host. Caddy on the
  // host reaches the whiteboard and LiveKit reaches Redis from the host, which
  // FORWARD does not see; it sees only traffic between containers and out.
  const forward = [
    `-i om-bridge ! -s ${BRIDGE_SUBNET} -j DROP`,
    "-m conntrack --ctstate ESTABLISHED,RELATED -j RETURN",
    ...(runs("egress") ? [`-s ${EGRESS} -d ${REDIS} -p tcp --dport 6379 -j RETURN`] : []),
    // No ingress to containers, even through an accidentally published port,
    // and no container egress to private ranges.
    `-i ${iface} -d ${BRIDGE_SUBNET} -j DROP`,
    ...PRIVATE_DESTINATIONS.map((destination) => `-s ${BRIDGE_SUBNET} -d ${destination} -j DROP`),
    "-j RETURN",
  ];
  const table = (chains: Record<string, string[]>) => [
    "*filter",
    ...Object.keys(chains).map((chain) => `:${chain} -`),
    ...Object.entries(chains).flatMap(([chain, rules]) => rules.map((rule) => `-A ${chain} ${rule}`)),
    "COMMIT",
    "",
  ].join("\n");
  return { v4: table({ "ORBMEET-INPUT": inputV4, "ORBMEET-FORWARD": forward }), v6: table({ "ORBMEET-INPUT": inputV6 }) };
}

/**
 * Caddy on a node: signalling on its rtc name, TURN/TLS by SNI on its turn
 * name, and the whiteboard sync server on its whiteboard name when it runs one.
 */
function caddyfile(inv: Inventory, name: string): string {
  const whiteboardSite = [
    "# The whiteboard sync server, for the boards the Worker places on this node.",
    `${whiteboardHost(inv, name)} {`,
    "    import site",
    `    reverse_proxy ${WHITEBOARD}:8787`,
    "}",
    "",
  ].join("\n");
  const values: Record<string, string> = {
    RTC_HOST: rtcHost(inv, name), TURN_HOST: turnHost(inv, name),
    LIVEKIT: `${GATEWAY}:7880`, TURN: `${GATEWAY}:5350`,
    WHITEBOARD_SITE: inv.nodes[name].services.includes("whiteboard") ? `\n${whiteboardSite}` : "",
  };
  const template = readFileSync(join(NODE_DIR, "caddy/Caddyfile.tmpl"), "utf8");
  return template.replace(/\$(?:(\$)|([_a-zA-Z][_a-zA-Z0-9]*)|\{([_a-zA-Z][_a-zA-Z0-9]*)\})/g,
    (_, dollar: string | undefined, bare: string | undefined, braced: string | undefined) => {
      if (dollar) return "$";
      const key = (bare ?? braced)!;
      if (!(key in values)) throw new OpsError(`Caddyfile.tmpl: unknown placeholder $${key}`);
      return values[key];
    });
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/** One node's runtime files, by name: its configuration, secrets, firewall and environment. */
export function renderNode(inv: Inventory, c: Secrets, name: string): Map<string, string> {
  const node = inv.nodes[name];
  const containers = node.containers as string[];
  const s = c.nodes[name];
  const files = new Map<string, string>();
  const fileDigest = (names: string[]) => {
    const h = createHash("sha256");
    // digest() over the rendered files, without writing them first.
    for (const file of [...names].sort()) h.update(file).update(files.get(file)!);
    return h.digest("hex").slice(0, 24);
  };
  const values: Record<string, string> = {
    APP_URL: inv.appUrl,
    ALLOWED_ORIGINS: `${inv.appUrl},https://www.${inv.domain}`,
    NODE: name,
    CADDY_BUILD: digest([join(NODE_DIR, "caddy/Dockerfile")]),
    ...Object.fromEntries(Object.entries(node.memoryLimits)
      .map(([container, size]) => [`${container.toUpperCase()}_MEMORY`, size])),
  };
  if (containers.includes("caddy")) {
    files.set("Caddyfile", caddyfile(inv, name));
    values.CADDY_CONFIG = fileDigest(["Caddyfile"]);
  }
  if (containers.includes("livekit")) {
    const [apiKey] = signingKey(c, name);
    const redis = { address: `${REDIS}:6379`, password: s.REDIS_PASSWORD };
    files.set("livekit.json", json({
      // One JSON object a line, which ship-logs.jq reads.
      port: 7880, logging: { level: "info", json: true }, bind_addresses: [GATEWAY],
      prometheus: { port: 6789 },
      rtc: { tcp_port: 7881, udp_port: "7882-7885", use_external_ip: false,
        node_ip: node.ipv4, enable_loopback_candidate: false,
        interfaces: { includes: [node.interface] } },
      redis,
      turn: { enabled: true, domain: turnHost(inv, name), udp_port: 443, tls_port: 5350, external_tls: true },
      // No cap of LiveKit's own (0): the meeting's room admits by the plan's
      // limit (seatAvailable in apps/web), and a lower one here would refuse
      // a participant the meeting already admitted.
      room: { max_participants: 0, empty_timeout: 60, departure_timeout: 120 },
      keys: { ...s.LIVEKIT_KEYS, [s.LIVEKIT_EGRESS_API_KEY]: s.LIVEKIT_EGRESS_API_SECRET,
        [s.LIVEKIT_TRANSCRIPTION_API_KEY]: s.LIVEKIT_TRANSCRIPTION_API_SECRET },
      webhook: { api_key: apiKey, urls: [`${inv.appUrl}/api/livekit/webhook`] },
    }));
    values.LIVEKIT_CONFIG = fileDigest(["livekit.json"]);
    const passwordHash = createHash("sha256").update(s.REDIS_PASSWORD).digest("hex");
    files.set("redis_password", `${s.REDIS_PASSWORD}\n`);
    files.set("redis.acl", `user default on #${passwordHash} ~* &* +@all `
      + "-acl -config -debug -module -function -migrate -restore -flushall -flushdb "
      + "-shutdown -swapdb -replicaof -slaveof -bgrewriteaof -bgsave -save\n");
    files.set("redis.conf", `bind 127.0.0.1 ${REDIS}\nprotected-mode yes\n`
      + 'port 6379\naclfile /etc/redis/users.acl\nsave ""\nappendonly no\n'
      + "maxmemory 384mb\nmaxmemory-policy noeviction\n");
    values.REDIS_CONFIG = fileDigest(["redis.conf", "redis.acl", "redis_password"]);
    files.set("egress.json", json({
      api_key: s.LIVEKIT_EGRESS_API_KEY, api_secret: s.LIVEKIT_EGRESS_API_SECRET,
      // Public, because the recorder page Chrome loads connects with it too.
      ws_url: `wss://${rtcHost(inv, name)}`,
      redis,
      health_port: 9090, prometheus_port: 9091,
      logging: { level: "info" }, enable_chrome_sandbox: true,
      // Egress reads its CPU count from the cgroup quota (compose `cpus: 2`),
      // so a cost above 2 would refuse every request. One composite at a time.
      // It refuses work that would take it past max_memory (in GB), a
      // gigabyte under its container's limit.
      cpu_cost: { room_composite_cpu_cost: 2, web_cpu_cost: 2, memory_cost: 2,
        max_memory: Math.max(1, Math.floor(mebibytes(node.memoryLimits.egress) / 1024) - 1) },
      // Requests name only a file path; every upload uses Egress's own
      // token, and nothing is ever left on the node's disk.
      storage: { s3: { access_key: c.EGRESS_R2_ACCESS_KEY_ID, secret: c.EGRESS_R2_SECRET_ACCESS_KEY, region: "auto",
        endpoint: `https://${c.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        bucket: c.R2_BUCKET_NAME, force_path_style: true } },
      disallow_local_storage: true,
    }));
    // Compose names the seccomp profile by path, so its own service hash
    // ignores the profile's contents. Put its pinned hash in the label
    // Compose does compare, so a revendored profile recreates Egress.
    values.EGRESS_CONFIG = `${fileDigest(["egress.json"])}-${EGRESS_SECCOMP_SHA256.slice(0, 12)}`;
  }
  if (containers.includes("whiteboard")) {
    // The node's own keyrings: its tokens, commands and calls are its alone.
    for (const key of WHITEBOARD_KEYRINGS) files.set(key.toLowerCase(), `${JSON.stringify(s[key])}\n`);
    for (const key of R2_KEYS) files.set(key.toLowerCase(), `${c[key]}\n`);
    const keys = [...WHITEBOARD_KEYRINGS, ...R2_KEYS];
    // Empty when unset: the server then runs without the assistant.
    const aiKey = c[AI_KEY] ?? "";
    files.set("ai_api_key", `${aiKey}\n`);
    values.ASSISTANT_MODEL = aiKey ? ASSISTANT_MODEL : "";
    values.WHITEBOARD_CONFIG = fileDigest([...keys.map((key) => key.toLowerCase()), "ai_api_key"]);
    values.WHITEBOARD_BUILD = imageBuild("whiteboard");
  }
  if (containers.includes("transcription")) {
    const secretFiles: Record<string, string> = {
      transcription_livekit_api_key: s.LIVEKIT_TRANSCRIPTION_API_KEY,
      transcription_livekit_api_secret: s.LIVEKIT_TRANSCRIPTION_API_SECRET,
      transcription_internal_secret: s.TRANSCRIPTION_INTERNAL_SECRET,
      deepgram_api_key: c[DEEPGRAM_KEY],
    };
    for (const [file, value] of Object.entries(secretFiles)) files.set(file, `${value}\n`);
    // The agent joins its own node's rooms at LiveKit's API on the bridge's gateway.
    values.TRANSCRIPTION_LIVEKIT_URL = `ws://${GATEWAY}:7880`;
    values.TRANSCRIPTION_INTERNAL_KEY_ID = s.TRANSCRIPTION_INTERNAL_KEY_ID;
    values.TRANSCRIPTION_CONFIG = fileDigest(Object.keys(secretFiles));
    values.TRANSCRIPTION_BUILD = imageBuild("transcription");
  }
  files.set("compose.env", Object.entries(values).map(([k, v]) => `${k}=${v}\n`).join(""));
  const rules = firewallRules(inv, name);
  files.set("firewall.v4", rules.v4);
  files.set("firewall.v6", rules.v6);
  const env = { NODE: name, SERVICES: containers.join(" "), AXIOM_TOKEN: c.AXIOM_TOKEN, AXIOM_DATASET };
  files.set("host.env", Object.entries(env).map(([k, v]) => `${k}=${shellQuote(v)}\n`).join(""));
  return files;
}

/** Render every node's runtime files into <dir>/<node>, from scratch, so a node keeps nothing it no longer runs. */
export function prepare(inv: Inventory, c: Secrets, dir: string): void {
  const seccomp = readFileSync(join(NODE_DIR, "egress-seccomp.json"));
  if (createHash("sha256").update(seccomp).digest("hex") !== EGRESS_SECCOMP_SHA256) {
    throw new OpsError("node/egress-seccomp.json does not match the pinned upstream v1.14.1 profile");
  }
  rmSync(dir, { recursive: true, force: true });
  for (const name of Object.keys(inv.nodes)) {
    for (const [file, value] of renderNode(inv, c, name)) writePrivate(join(dir, name, file), value);
  }
}

/** The Worker's NODES, checked with the schema the Worker reads it with. */
export function nodesSecret(inv: Inventory, c: Secrets, drained?: string): string {
  const nodes: NodesInput = {};
  for (const [name, { region, weight, services, mediaCapacity }] of Object.entries(inv.nodes)) {
    const s = c.nodes[name];
    nodes[name] = {
      region,
      // A draining node keeps its Meetings and boards but is given no new ones.
      weight: name === drained ? 0 : weight,
      ...(services.includes("media")
        ? { media: { url: `wss://${rtcHost(inv, name)}`, capacity: mediaCapacity!, keys: s.LIVEKIT_KEYS } }
        : {}),
      ...(services.includes("whiteboard")
        ? {
            whiteboard: {
              url: `https://${whiteboardHost(inv, name)}`,
              jwt: s.WHITEBOARD_JWT_KEYS,
              command: s.WHITEBOARD_COMMAND_KEYS,
              callback: s.WHITEBOARD_CALLBACK_KEYS,
            },
          }
        : {}),
    };
  }
  const serialized = JSON.stringify(nodes);
  parseNodes(serialized);
  return serialized;
}
