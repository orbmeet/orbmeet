import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ASSISTANT_MODEL, DOCKERFILES, NODE_DIR, ROOT, SERVICES } from "./catalog.ts";
import { loadInventory } from "./inventory.ts";
import { digest, firewallRules, imageSources, nodesSecret, prepare, productionFiles, renderNode } from "./render.ts";
import { EGRESS_R2_KEYS, IMPORTED_KEYS, signingKey } from "./secrets.ts";
import { fakeSecrets, INVENTORY, inventory } from "./test-fixtures.ts";

function render(data: unknown = INVENTORY) {
  const inv = loadInventory(data);
  const c = fakeSecrets();
  const nodes = Object.fromEntries(Object.keys(inv.nodes).map((name) => [name, Object.fromEntries(renderNode(inv, c, name))]));
  return { inv, c, nodes };
}

const env = (file: string) => Object.fromEntries(file.trim().split("\n").map((line) => line.split(/=(.*)/s).slice(0, 2)));

describe("rendering", () => {
  it("turns the whiteboard assistant on only with its key", () => {
    const inv = loadInventory(INVENTORY);
    const without = Object.fromEntries(renderNode(inv, fakeSecrets(), "sg1"));
    expect(env(without["compose.env"]).ASSISTANT_MODEL).toBe("");
    expect(without.ai_api_key).toBe("\n");

    const withKey = Object.fromEntries(renderNode(inv, { ...fakeSecrets(), AI_API_KEY: "provider-key" }, "sg1"));
    expect(env(withKey["compose.env"]).ASSISTANT_MODEL).toBe(ASSISTANT_MODEL);
    expect(withKey.ai_api_key).toBe("provider-key\n");
    // A new key recreates the whiteboard container.
    expect(env(withKey["compose.env"]).WHITEBOARD_CONFIG).not.toBe(env(without["compose.env"]).WHITEBOARD_CONFIG);
  });

  it("writes private files, the same each time", () => {
    const dir = mkdtempSync(join(tmpdir(), "ops-render-"));
    const inv = loadInventory(INVENTORY);
    const read = () => Object.fromEntries(readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile()).map((entry) => [join(entry.parentPath, entry.name), readFileSync(join(entry.parentPath, entry.name), "utf8")]));
    prepare(inv, fakeSecrets(), dir);
    const first = read();
    prepare(inv, fakeSecrets(), dir);
    expect(read()).toEqual(first);
    for (const path of Object.keys(first)) expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("gives each node only what its services need", () => {
    const { c, nodes } = render();
    const media = ["Caddyfile", "livekit.json", "redis.conf", "redis.acl", "redis_password", "egress.json",
      "transcription_livekit_api_key", "transcription_livekit_api_secret", "transcription_internal_secret", "deepgram_api_key"];
    const whiteboard = ["whiteboard_command_keys", "whiteboard_callback_keys", "whiteboard_jwt_keys", "r2_access_key_id",
      "r2_secret_access_key", "r2_account_id", "r2_bucket_name", "ai_api_key"];
    const common = ["compose.env", "host.env", "firewall.v4", "firewall.v6"];
    expect(new Set(Object.keys(nodes.sg1))).toEqual(new Set([...common, ...media, ...whiteboard]));
    expect(new Set(Object.keys(nodes.my1))).toEqual(new Set([...common, ...media]));
    const my1 = Object.values(nodes.my1).join("");
    // A node without the whiteboard holds only Egress's storage token among
    // the shared secrets, and no other node's LiveKit or Redis secrets.
    const storage = new Set<string>([...EGRESS_R2_KEYS, "R2_ACCOUNT_ID", "R2_BUCKET_NAME", "DEEPGRAM_API_KEY", "AXIOM_TOKEN"]);
    for (const key of IMPORTED_KEYS) expect([key, my1.includes(c[key])]).toEqual([key, storage.has(key)]);
    const sg1 = c.nodes.sg1;
    for (const secret of [...Object.values(sg1.LIVEKIT_KEYS), sg1.REDIS_PASSWORD, sg1.LIVEKIT_EGRESS_API_SECRET,
      sg1.LIVEKIT_TRANSCRIPTION_API_SECRET, sg1.TRANSCRIPTION_INTERNAL_SECRET]) {
      expect(my1).not.toContain(secret);
    }
    // A whiteboard node holds its own whiteboard keyrings, and no other node's.
    expect(JSON.parse(nodes.sg1.whiteboard_jwt_keys)).toEqual(sg1.WHITEBOARD_JWT_KEYS);
    expect(Object.values(nodes.sg1).join("")).not.toContain(Object.values(c.nodes.my1.WHITEBOARD_JWT_KEYS)[0]);
  });

  it("keeps media configuration node-local", () => {
    const { c, nodes } = render();
    for (const name of ["sg1", "my1"]) {
      const s = c.nodes[name];
      const [apiKey, apiSecret] = signingKey(c, name);
      const livekit = JSON.parse(nodes[name]["livekit.json"]);
      expect(livekit.keys).toEqual({ [apiKey]: apiSecret, [s.LIVEKIT_EGRESS_API_KEY]: s.LIVEKIT_EGRESS_API_SECRET,
        [s.LIVEKIT_TRANSCRIPTION_API_KEY]: s.LIVEKIT_TRANSCRIPTION_API_SECRET });
      const values = env(nodes[name]["compose.env"]);
      // Each agent transcribes its own node's rooms and delivers with its own key.
      // Its own node's LiveKit, on the bridge.
      expect(values.TRANSCRIPTION_LIVEKIT_URL).toBe("ws://172.30.22.1:7880");
      expect(values.TRANSCRIPTION_INTERNAL_KEY_ID).toBe(s.TRANSCRIPTION_INTERNAL_KEY_ID);
      expect(nodes[name].transcription_internal_secret).toBe(`${s.TRANSCRIPTION_INTERNAL_SECRET}\n`);
      expect(livekit.redis).toEqual({ address: "172.30.22.10:6379", password: s.REDIS_PASSWORD });
      expect(livekit.bind_addresses).toEqual(["172.30.22.1"]);
      expect(livekit.turn.domain).toBe(`${name}.turn.app.example.com`);
      expect(livekit.rtc.node_ip).toBe(INVENTORY.nodes[name as "sg1"].ipv4);
      expect(livekit.webhook).toEqual({ api_key: apiKey, urls: ["https://app.example.com/api/livekit/webhook"] });
      const egress = JSON.parse(nodes[name]["egress.json"]);
      expect(egress.ws_url).toBe(`wss://${name}.rtc.app.example.com`);
      expect(egress.redis).toEqual(livekit.redis);
      expect(egress.storage.s3.access_key).toBe(c.EGRESS_R2_ACCESS_KEY_ID);
      expect(egress.storage.s3.bucket).toBe(c.R2_BUCKET_NAME);
      expect(egress.disallow_local_storage).toBe(true);
      expect(egress.cpu_cost.room_composite_cpu_cost).toBeLessThanOrEqual(2);
    }
    const my1 = env(nodes.my1["compose.env"]);
    expect(my1).toMatchObject({ CADDY_MEMORY: "256m", LIVEKIT_MEMORY: "2g", REDIS_MEMORY: "512m", EGRESS_MEMORY: "3g",
      TRANSCRIPTION_MEMORY: "1536m" });
    expect(my1).not.toHaveProperty("WHITEBOARD_MEMORY");
    // Egress refuses work beyond a gigabyte under its limit.
    expect(JSON.parse(nodes.my1["egress.json"]).cpu_cost.max_memory).toBe(2);
    expect(JSON.parse(nodes.sg1["egress.json"]).cpu_cost.max_memory).toBe(3);
    expect(my1).not.toHaveProperty("WHITEBOARD_BUILD");
    expect(nodes.my1["host.env"]).toBe("NODE=my1\nSERVICES='caddy livekit redis egress transcription'\n"
      + `AXIOM_TOKEN=${fakeSecrets().AXIOM_TOKEN}\nAXIOM_DATASET=orbmeet\n`);
  });

  it("renders every key of a rotation and signs with the first", () => {
    const inv = loadInventory(INVENTORY);
    const c = fakeSecrets();
    c.nodes.my1.LIVEKIT_KEYS = { "my1-new": "n".repeat(40), "my1-app": "o".repeat(40) };
    const livekit = JSON.parse(renderNode(inv, c, "my1").get("livekit.json")!);
    expect(new Set(Object.keys(livekit.keys))).toEqual(new Set(["my1-new", "my1-app", "my1-egress", "my1-transcription"]));
    expect(livekit.webhook.api_key).toBe("my1-new");
  });

  it("leaves room size to the meeting, which admits by plan", () => {
    const livekit = JSON.parse(render().nodes.my1["livekit.json"]);
    expect(livekit.room.max_participants).toBe(0);
  });

  it("serves each node's own names from Caddy, its whiteboard among them when it runs one", () => {
    const { nodes } = render();
    for (const name of ["sg1", "my1"]) {
      const caddy = nodes[name].Caddyfile;
      expect(caddy).toContain(`${name}.rtc.app.example.com {`);
      expect(caddy).toContain(`${name}.turn.app.example.com {`);
      expect(caddy).toContain(`@turn tls sni ${name}.turn.app.example.com`);
      expect(caddy).toContain("proxy tcp/172.30.22.1:5350");
      expect(caddy).toContain("reverse_proxy 172.30.22.1:7880");
      expect(caddy).not.toContain("$");
    }
    expect(nodes.sg1.Caddyfile).toContain("sg1.whiteboard.app.example.com {\n    import site\n    reverse_proxy 172.30.22.3:8787\n}");
    expect(nodes.my1.Caddyfile).not.toContain("whiteboard.app.example.com");
  });

  it("keeps whiteboard tokens out of Caddy's logs", () => {
    const caddy = render().nodes.sg1.Caddyfile;
    expect(caddy.match(/request>headers>Sec-Websocket-Protocol delete/g)).toHaveLength(2);
  });

  it("publishes each node's services in NODES", () => {
    const inv = loadInventory(inventory({ my1: { weight: 3, region: "sin" } }));
    const c = fakeSecrets();
    expect(JSON.parse(nodesSecret(inv, c))).toEqual({
      sg1: {
        region: "sg1",
        weight: 2,
        media: { url: "wss://sg1.rtc.app.example.com", capacity: 60, keys: c.nodes.sg1.LIVEKIT_KEYS },
        whiteboard: {
          url: "https://sg1.whiteboard.app.example.com",
          jwt: c.nodes.sg1.WHITEBOARD_JWT_KEYS,
          command: c.nodes.sg1.WHITEBOARD_COMMAND_KEYS,
          callback: c.nodes.sg1.WHITEBOARD_CALLBACK_KEYS,
        },
      },
      my1: {
        region: "sin",
        weight: 3,
        media: { url: "wss://my1.rtc.app.example.com", capacity: 30, keys: c.nodes.my1.LIVEKIT_KEYS },
      },
    });
  });

  it("keeps image tags across test-only changes", () => {
    const root = mkdtempSync(join(tmpdir(), "ops-digest-"));
    writeFileSync(join(root, "main.ts"), "runtime");
    writeFileSync(join(root, "main.test.ts"), "first test");
    mkdirSync(join(root, "node_modules"));
    writeFileSync(join(root, "node_modules/dependency.ts"), "not source");
    const first = digest(productionFiles(root), root);
    writeFileSync(join(root, "main.test.ts"), "changed test");
    expect(digest(productionFiles(root), root)).toBe(first);
    writeFileSync(join(root, "main.ts"), "changed runtime");
    expect(digest(productionFiles(root), root)).not.toBe(first);
  });

  it("sends and hashes every workspace package an image needs", () => {
    // A workspace package an image misses builds one that fails at startup.
    const packages = new Map<string, string>();
    for (const parent of ["apps", "packages"]) {
      for (const dir of readdirSync(join(ROOT, parent))) {
        try {
          packages.set(JSON.parse(readFileSync(join(ROOT, parent, dir, "package.json"), "utf8")).name, `${parent}/${dir}`);
        } catch { /* not a package */ }
      }
    }
    for (const [service, dockerfile] of Object.entries(DOCKERFILES)) {
      const app = dockerfile.split("/").slice(0, 2).join("/");
      const needed = new Set<string>();
      const pending = [JSON.parse(readFileSync(join(ROOT, app, "package.json"), "utf8")).name as string];
      while (pending.length) {
        const directory = packages.get(pending.pop()!)!;
        if (needed.has(directory)) continue;
        needed.add(directory);
        const manifest = JSON.parse(readFileSync(join(ROOT, directory, "package.json"), "utf8"));
        pending.push(...Object.entries(manifest.dependencies ?? {})
          .filter(([, spec]) => String(spec).startsWith("workspace:")).map(([dep]) => dep));
      }
      expect(new Set(imageSources(service as keyof typeof DOCKERFILES))).toEqual(needed);
    }
  });

  it("matches the Compose profiles to the service catalog", () => {
    // deploy.sh enables one profile per container a node runs, so each must exist by that name.
    const compose = readFileSync(join(NODE_DIR, "compose.yaml"), "utf8");
    const services = compose.split("\nservices:\n")[1].split("\nnetworks:\n")[0];
    const defined = [...services.matchAll(/^ {2}([a-z]+):\n/gm)].map((m) => m[1]);
    const profiles = Object.fromEntries([...compose.matchAll(/^ {2}([a-z]+):\n(?: {4}.*\n)*? {4}profiles: \[([a-z]+)\]/gm)]
      .map((m) => [m[1], m[2]]));
    const containers = Object.values(SERVICES).flat();
    expect(new Set(defined)).toEqual(new Set(containers));
    expect(profiles).toEqual(Object.fromEntries(containers.map((c) => [c, c])));
  });
});

describe("firewall", () => {
  const rules = (name: string, data: unknown = INVENTORY) => firewallRules(loadInventory(data), name);

  it("opens the public ports of the node's services", () => {
    const { v4 } = rules("my1");
    expect(v4).toContain("-A ORBMEET-INPUT -p tcp -m multiport --dports 80,443,7881 -j ACCEPT");
    expect(v4).toContain("-A ORBMEET-INPUT -p udp -m multiport --dports 443,7882:7885 -j ACCEPT");
  });

  it("forwards only what passes between containers: Egress to Redis", () => {
    for (const name of ["sg1", "my1"]) {
      const forward = rules(name).v4.split("\n").filter((rule) => rule.startsWith("-A ORBMEET-FORWARD") && rule.endsWith("RETURN"));
      expect(forward).toEqual([
        "-A ORBMEET-FORWARD -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN",
        "-A ORBMEET-FORWARD -s 172.30.22.11 -d 172.30.22.10 -p tcp --dport 6379 -j RETURN",
        "-A ORBMEET-FORWARD -j RETURN",
      ]);
      // Nothing is published, and the bridge reaches no private range.
      expect(rules(name).v4).toContain("-A ORBMEET-FORWARD -i enp0s6 -d 172.30.22.0/28 -j DROP".replace("enp0s6", name === "sg1" ? "enp0s6" : "eth0"));
      expect(rules(name).v4).toContain("-A ORBMEET-FORWARD -s 172.30.22.0/28 -d 169.254.0.0/16 -j DROP");
    }
  });

  it.each([["egress", "172.30.22.11"], ["the transcription agent", "172.30.22.12"]])("lets %s join its own node", (_, client) => {
    const { v4 } = rules("my1");
    // Signalling and media at the host's own addresses, before the rule that stops containers reaching the host.
    for (const rule of [`-A ORBMEET-INPUT -i om-bridge -s ${client} -p tcp -m multiport --dports 443,7880,7881 -j ACCEPT`,
      `-A ORBMEET-INPUT -i om-bridge -s ${client} -p udp -m multiport --dports 443,7882:7885 -j ACCEPT`]) {
      expect(v4.indexOf(rule)).toBeGreaterThan(-1);
      expect(v4.indexOf(rule)).toBeLessThan(v4.indexOf("-A ORBMEET-INPUT -i om-+ -j DROP"));
    }
  });

  it("writes complete restore transactions", () => {
    for (const name of Object.keys(INVENTORY.nodes)) {
      const { v4, v6 } = rules(name);
      expect(v4.startsWith("*filter\n:ORBMEET-INPUT -\n:ORBMEET-FORWARD -\n")).toBe(true);
      expect(v6.startsWith("*filter\n:ORBMEET-INPUT -\n-A ")).toBe(true);
      expect(v6).not.toContain("ORBMEET-FORWARD");
      expect(v4.endsWith("-A ORBMEET-FORWARD -j RETURN\nCOMMIT\n")).toBe(true);
      expect(v6.endsWith("-A ORBMEET-INPUT -j DROP\nCOMMIT\n")).toBe(true);
      expect(v4).toContain("-A ORBMEET-INPUT -j DROP\n-A ORBMEET-FORWARD");
    }
  });
});
