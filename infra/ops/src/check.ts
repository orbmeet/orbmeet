import { createSocket } from "node:dgram";
import { lookup } from "node:dns/promises";
import { connect as tcpConnect, type Socket } from "node:net";
import { networkInterfaces } from "node:os";
import { randomBytes } from "node:crypto";
import { connect as tlsConnect } from "node:tls";
import { INTERNAL_PORTS } from "./catalog.ts";
import { mediaNodes, rtcHost, turnHost, whiteboardHost, whiteboardNodes, type Inventory } from "./inventory.ts";
import { liveKitApi } from "./livekit.ts";
import { ssh } from "./remote.ts";
import type { Secrets } from "./secrets.ts";
import { OpsError, type Shell } from "./shell.ts";

/*
 * External reachability, TLS, STUN and authenticated API checks: what a
 * client sees of each node. They do not prove media quality.
 */

const MAGIC_COOKIE = 0x2112a442;

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new OpsError(`${what}: timed out`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

function tcpOpen(address: string, port: number, ms = 5000): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = tcpConnect({ host: address, port, timeout: ms });
    socket.once("connect", () => {
      socket.setTimeout(0);
      resolve(socket);
    });
    socket.once("timeout", () => {
      socket.destroy();
      reject(new OpsError(`${address}:${port}: timed out`));
    });
    socket.once("error", reject);
  });
}

/** A STUN Binding request; TURN/UDP on 443 must answer it. */
export function stunRequest(transaction: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt16BE(0x0001, 0);
  header.writeUInt16BE(0, 2);
  header.writeUInt32BE(MAGIC_COOKIE, 4);
  return Buffer.concat([header, transaction]);
}

/** An unauthenticated TURN Allocate for UDP; the server must answer with an authentication challenge. */
export function turnAllocate(transaction: Buffer): Buffer {
  const attribute = Buffer.alloc(8);
  attribute.writeUInt16BE(0x0019, 0); // REQUESTED-TRANSPORT
  attribute.writeUInt16BE(4, 2);
  attribute.writeUInt32BE(17 << 24, 4); // UDP
  const header = Buffer.alloc(8);
  header.writeUInt16BE(0x0003, 0);
  header.writeUInt16BE(attribute.length, 2);
  header.writeUInt32BE(MAGIC_COOKIE, 4);
  return Buffer.concat([header, transaction, attribute]);
}

/** Whether `answer` is the given STUN message type for `transaction`. */
export function stunAnswers(answer: Buffer, type: number, transaction: Buffer): boolean {
  return answer.length >= 20 && answer.readUInt16BE(0) === type && answer.subarray(8, 20).equals(transaction);
}

/**
 * A Binding request, resent every half second as a client's ICE agent would:
 * some providers' DDoS filters drop the first UDP packet from a source they
 * have not seen lately, so one unanswered packet proves nothing.
 */
async function stun(address: string): Promise<void> {
  const transaction = randomBytes(12);
  const socket = createSocket("udp4");
  let resend: NodeJS.Timeout | undefined;
  try {
    const answer = await withTimeout(new Promise<Buffer>((resolve, reject) => {
      socket.once("message", resolve);
      socket.once("error", reject);
      const send = () => socket.send(stunRequest(transaction), 443, address);
      send();
      resend = setInterval(send, 500);
    }), 5000, `${address}: STUN`);
    if (!stunAnswers(answer, 0x0101, transaction)) throw new OpsError(`${address}: unexpected STUN binding response`);
  } finally {
    clearInterval(resend);
    socket.close();
  }
}

async function turnTls(address: string, host: string): Promise<void> {
  const transaction = randomBytes(12);
  const socket = tlsConnect({ host: address, port: 443, servername: host });
  try {
    const answer = await withTimeout(new Promise<Buffer>((resolve, reject) => {
      socket.once("secureConnect", () => socket.write(turnAllocate(transaction)));
      socket.once("data", resolve);
      socket.once("error", reject);
    }), 5000, `${host}: TURN/TLS`);
    if (!stunAnswers(answer, 0x0113, transaction)) throw new OpsError(`${host}: unexpected TURN/TLS Allocate response`);
  } finally {
    socket.destroy();
  }
}

async function checkDns(host: string, ipv4: string, ipv6: string | null): Promise<void> {
  const answers = new Set((await lookup(host, { all: true })).map((answer) => answer.address));
  const allowed = new Set([ipv4, ...(ipv6 ? [ipv6] : [])]);
  if (!answers.has(ipv4) || [...answers].some((answer) => !allowed.has(answer))) {
    throw new OpsError(`DNS for ${host} should point only to its node: ${[...answers].sort().join(", ")}. `
      + `Set it with \`pnpm exec cf dns records create\` (an A record to ${ipv4}, DNS only)`);
  }
}

/** This machine's IPv4 addresses: a node's public edge cannot be probed from itself. */
function ownIpv4(): Set<string> {
  return new Set(Object.values(networkInterfaces()).flatMap((infos) => infos ?? [])
    .filter((info) => info.family === "IPv4").map((info) => info.address));
}

/** Which of `ports` accept a TCP connection at `address`; null when this machine cannot reach the address's family at all. */
async function openPorts(address: string, ports: readonly number[]): Promise<number[] | null> {
  const results = await Promise.all(ports.map(async (port) => {
    try {
      (await tcpOpen(address, port, 3000)).destroy();
      return port;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (error instanceof OpsError || code === "ECONNREFUSED") return null;
      if (code === "ENETUNREACH" || code === "EHOSTUNREACH" || code === "EADDRNOTAVAIL") return "unreachable" as const;
      throw new OpsError(`Could not check ${address}:${port}: ${(error as Error).message}`);
    }
  }));
  if (results.includes("unreachable")) return null;
  return results.filter((port) => typeof port === "number");
}

/**
 * Every internal port must be unreachable at the node's public addresses.
 *
 * Traffic from a node to its own address arrives over `lo`, which its
 * firewall accepts, so a node this tool runs on is probed by another node
 * over the network; a lone node checked only from itself is skipped. IPv6 is
 * probed when this machine has it.
 */
async function publicPortsClosed(shell: Shell, inv: Inventory, name: string, own: Set<string>): Promise<void> {
  const { ipv4, ipv6 } = inv.nodes[name];
  let reachable: number[];
  if (!own.has(ipv4)) {
    reachable = (await openPorts(ipv4, INTERNAL_PORTS)) ?? [];
  } else {
    const other = Object.keys(inv.nodes).find((n) => n !== name);
    if (!other) {
      console.log(`SKIP ${name}: no other node to probe its public edge from`);
      return;
    }
    const script = `for port in ${INTERNAL_PORTS.join(" ")}; do`
      + ` timeout 5 bash -c "</dev/tcp/${ipv4}/$port" 2>/dev/null && echo $port; done; true`;
    reachable = (await ssh(shell, inv, other, script, { capture: true })).split(/\s+/).filter(Boolean).map(Number);
  }
  if (reachable.length) throw new OpsError(`Public internal port on ${name}: ${reachable.join(", ")}`);
  console.log(`PASS ${name}: internal TCP ports inaccessible at its public IPv4 address`);
  if (!ipv6) return;
  const reachableV6 = await openPorts(ipv6, INTERNAL_PORTS);
  if (reachableV6 === null) {
    console.log(`SKIP ${name}: this machine has no IPv6 route to probe ${ipv6} from`);
    return;
  }
  if (reachableV6.length) throw new OpsError(`Public internal port on ${name} over IPv6: ${reachableV6.join(", ")}`);
  console.log(`PASS ${name}: internal TCP ports inaccessible at its public IPv6 address`);
}

export async function check(shell: Shell, inv: Inventory, c: Secrets, { externalOnly = false } = {}): Promise<void> {
  if (!externalOnly) {
    for (const name of Object.keys(inv.nodes)) await ssh(shell, inv, name, "sudo -n /usr/local/sbin/orbmeet-health check");
  }
  for (const name of mediaNodes(inv)) {
    const node = inv.nodes[name];
    await checkDns(rtcHost(inv, name), node.ipv4, node.ipv6);
    await checkDns(turnHost(inv, name), node.ipv4, node.ipv6);
    const rooms = await liveKitApi(inv, c, name).rooms.listRooms();
    console.log(`PASS ${name}: DNS, TLS and signed LiveKit API, ${rooms.length} rooms`);
    (await tcpOpen(node.ipv4, 7881)).destroy();
    console.log(`PASS ${name}: WebRTC TCP listener`);
    await stun(node.ipv4);
    console.log(`PASS ${name}: TURN/UDP STUN binding`);
    await turnTls(node.ipv4, turnHost(inv, name));
    console.log(`PASS ${name}: TURN/TLS response for ${turnHost(inv, name)} (unauthenticated allocation)`);
  }
  for (const name of whiteboardNodes(inv)) {
    const node = inv.nodes[name];
    const host = whiteboardHost(inv, name);
    await checkDns(host, node.ipv4, node.ipv6);
    // Through its public name and Caddy, the way clients reach it.
    const response = await fetch(`https://${host}/health`, {
      headers: { "User-Agent": "orbmeet-ops-check" }, signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new OpsError(`${host}/health: HTTP ${response.status}`);
    console.log(`PASS ${name}: whiteboard DNS, TLS and health at ${host}`);
  }
  const own = ownIpv4();
  for (const name of Object.keys(inv.nodes)) await publicPortsClosed(shell, inv, name, own);
}
