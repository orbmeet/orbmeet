// The LiveKit a local stack runs in Docker: `pnpm dev`'s (setup-livekit.mjs)
// and the smoke tests' (e2e/livekit.ts). Both put LiveKit on this machine's
// loopback, where the browser reaches it and from where it posts its webhooks
// to the Vite dev server, and on ports no media node's LiveKit (7880-7885) or
// firewall rule uses, since this machine may run one.
import { spawnSync } from "node:child_process";
import { release } from "node:os";
import process from "node:process";

const LIVEKIT_IMAGE = "livekit/livekit-server:v1.13.6";

export type DockerNetworking = "host" | "published";

export interface LiveKitContainer {
  networking: DockerNetworking;
  name: string;
  /** Signalling; ICE over TCP, where offered, takes the next port and over UDP the one after. */
  port: number;
  keys: Record<string, string>;
  /** The dev server LiveKit posts its webhooks to, and the key it signs them with. */
  webhook: { apiKey: string; port: number };
  /** More `docker run` options, before the image. */
  dockerOptions?: readonly string[];
}

/**
 * How a container meets this machine's loopback, or null without Docker.
 *
 * - `host`: Docker Engine on Linux runs containers on this machine's kernel,
 *   and host networking gives them its very loopback.
 * - `published`: Docker Desktop, OrbStack and colima run them in a VM, where
 *   host networking means the VM's loopback, not this machine's. The ports are
 *   published on 127.0.0.1 instead, and the webhook goes to
 *   `host.docker.internal`, which these engines route to this machine.
 *
 * A daemon on this kernel reports this kernel's release; one in a VM, its own.
 * Rootless Docker fits neither: its containers live in a network namespace of
 * their own, and from there this machine's loopback is out of reach.
 */
export function dockerNetworking(): DockerNetworking | null {
  const info = spawnSync("docker", ["info", "--format", "{{.KernelVersion}}"], { encoding: "utf8" });
  if (info.error || info.status !== 0) return null;
  return process.platform === "linux" && info.stdout.trim() === release() ? "host" : "published";
}

/** The server's configuration, every address it advertises 127.0.0.1. */
function liveKitConfig({ networking, port, keys, webhook }: LiveKitContainer) {
  const onHost = networking === "host";
  return {
    port,
    // On host networking a listener is this machine's own, so it stays on
    // loopback. In a container's own network it listens on that network, and
    // only this machine's 127.0.0.1 is published to it.
    bind_addresses: [onHost ? "127.0.0.1" : "0.0.0.0"],
    rtc: {
      // LiveKit's ICE/TCP listener takes every interface whatever the
      // addresses above say, so on host networking there is none: UDP on
      // loopback never needs the fallback. Published, it is this machine's
      // 127.0.0.1 alone, and a VM's UDP forwarding can use it.
      tcp_port: onHost ? 0 : port + 1,
      udp_port: port + 2,
      node_ip: "127.0.0.1",
      use_external_ip: false,
      // On host networking, ICE gathers on loopback alone (which it skips
      // unless asked), so the media ports never open on this machine's other
      // interfaces. In a container it gathers on the container's interface,
      // and `node_ip` is what it advertises for it.
      ...(onHost ? { enable_loopback_candidate: true, ips: { includes: ["127.0.0.1/32"] } } : {}),
    },
    keys,
    webhook: {
      api_key: webhook.apiKey,
      urls: [`http://${onHost ? "127.0.0.1" : "host.docker.internal"}:${webhook.port}/api/livekit/webhook`],
    },
  };
}

/** `docker run` arguments for the container. */
export function liveKitRunArgs(container: LiveKitContainer): string[] {
  const { networking, name, port, dockerOptions = [] } = container;
  const config = liveKitConfig(container);
  const network = networking === "host"
    ? ["--network", "host"]
    : [
        "--add-host", "host.docker.internal:host-gateway",
        "--publish", `127.0.0.1:${port}:${port}/tcp`,
        "--publish", `127.0.0.1:${port + 1}:${port + 1}/tcp`,
        "--publish", `127.0.0.1:${port + 2}:${port + 2}/udp`,
      ];
  return [
    "run", "--name", name, ...network, ...dockerOptions,
    // YAML reads JSON, and an argument needs no file to mount or quote.
    LIVEKIT_IMAGE, "--config-body", JSON.stringify(config),
  ];
}
