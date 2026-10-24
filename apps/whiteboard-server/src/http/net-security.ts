// Network-trust primitives for the sync server: trusted-proxy resolution
// and the DNS-dependent SSRF guard used by the unfurler. Pure host/URL
// classification lives in @orbmeet/whiteboard-core/public-host so the browser
// can apply the same rules before creating a record.

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import {
  detectIpVersion,
  isPublicIpAddress,
  isStrictIpv4,
  isSuspiciousHostname,
  stripIpv6Brackets,
} from "@orbmeet/whiteboard-core/public-host";

export class UnsafeUnfurlTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeUnfurlTargetError";
  }
}

export const MAX_UNFURL_REDIRECTS = 5;

export type TrustedProxyMatcher =
  | { type: "exact"; ip: string }
  | { type: "ipv4-cidr"; base: number; mask: number };

function normalizeProxyIp(ip: string): string {
  const trimmed = ip.trim();
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("::ffff:")) return lower.slice("::ffff:".length);
  return lower;
}

/** A strict dotted-quad as a 32-bit number, or null for any other form. */
function ipv4ToNumber(ip: string): number | null {
  if (!isStrictIpv4(ip)) return null;
  return ip.split(".").reduce((result, part) => ((result << 8) | Number(part)) >>> 0, 0);
}

function parseTrustedProxyEntry(entry: string): TrustedProxyMatcher | null {
  const normalized = normalizeProxyIp(entry);
  if (!normalized) return null;

  // A malformed entry is dropped, never salvaged. Salvaging `10.0.0.0/8/16` as
  // `10.0.0.0/8` would quietly trust 16 million addresses an operator wrote a
  // narrower rule for. Every part has to be present and well-formed or the
  // entry is not a trusted proxy at all.
  const segments = normalized.split("/");
  if (segments.length > 2) return null;
  const [baseIp, prefixRaw] = segments;
  if (prefixRaw !== undefined) {
    const base = ipv4ToNumber(baseIp);
    const prefix = /^\d{1,2}$/.test(prefixRaw) ? Number(prefixRaw) : Number.NaN;
    if (base === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return { type: "ipv4-cidr", base: base & mask, mask };
  }

  return isIP(normalized) === 0 ? null : { type: "exact", ip: normalized };
}

export function parseTrustedProxyList(value: string | undefined): TrustedProxyMatcher[] {
  return (value || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map(parseTrustedProxyEntry)
    .filter((matcher): matcher is TrustedProxyMatcher => matcher !== null);
}

export function isTrustedProxyIp(ip: string, trustedProxies: readonly TrustedProxyMatcher[]): boolean {
  const normalized = normalizeProxyIp(ip);
  const ipv4 = ipv4ToNumber(normalized);

  return trustedProxies.some((matcher) => {
    if (matcher.type === "exact") return matcher.ip === normalized;
    return ipv4 !== null && (ipv4 & matcher.mask) === matcher.base;
  });
}

/**
 * Resolve the real client IP from X-Forwarded-For.
 *
 * The leftmost XFF entries are client-supplied and therefore spoofable — an
 * attacker can prepend any value to mint a fresh rate-limit bucket per request.
 * The reverse proxy (Caddy) appends the real peer to the *right* of whatever the
 * client sent, so we walk right-to-left and return the first hop that is not
 * itself a trusted proxy. Only call this once the immediate peer has been
 * confirmed to be a trusted proxy; otherwise XFF must be ignored entirely.
 */
export function resolveClientIp(
  xForwardedFor: string | null,
  connectingIp: string,
  trustedProxies: readonly TrustedProxyMatcher[],
): string {
  if (!xForwardedFor) return connectingIp;
  const hops = xForwardedFor
    .split(",")
    .map((hop) => normalizeProxyIp(hop))
    .filter(Boolean);
  for (let i = hops.length - 1; i >= 0; i--) {
    if (!isTrustedProxyIp(hops[i], trustedProxies)) return hops[i];
  }
  return connectingIp;
}

/**
 * C5 fix: returns the resolved addresses so callers can pin the connection
 * to the validated IP instead of re-resolving on fetch (TOCTOU prevention).
 */
export async function assertSafeUnfurlTarget(
  targetUrl: URL,
  signal?: AbortSignal,
): Promise<string[]> {
  if (!["http:", "https:"].includes(targetUrl.protocol)) {
    throw new UnsafeUnfurlTargetError("Only http/https URLs supported");
  }

  // URL.hostname keeps the brackets around an IPv6 literal; every classifier
  // and the DNS resolver below expect the bare address.
  const hostname = stripIpv6Brackets(targetUrl.hostname.trim());
  if (!hostname || isSuspiciousHostname(hostname)) {
    throw new UnsafeUnfurlTargetError("Hostname is not allowed");
  }

  // URL normalizes scheme-default ports away, so any explicit port here is
  // non-default. Refuse those: the unfurler should not be usable to probe
  // arbitrary services on otherwise-public hosts. Redirect hops re-enter this
  // check, so redirecting onto a custom port is refused too.
  if (targetUrl.port) {
    throw new UnsafeUnfurlTargetError("Only default http/https ports are supported");
  }

  const addresses = await resolveHostAddresses(hostname, signal);
  if (addresses.length === 0 || addresses.some((address) => !isPublicIpAddress(address))) {
    throw new UnsafeUnfurlTargetError("Resolved address is not public");
  }

  return addresses;
}

async function resolveHostAddresses(hostname: string, signal?: AbortSignal): Promise<string[]> {
  if (detectIpVersion(hostname) !== 0) return [hostname];
  const lookupTask = lookup(hostname, { all: true, verbatim: true });
  const results = signal
    ? await new Promise<Awaited<typeof lookupTask>>((resolve, reject) => {
        const abort = () => reject(new Error("Unfurl DNS resolution timed out"));
        if (signal.aborted) return abort();
        signal.addEventListener("abort", abort, { once: true });
        lookupTask.then(
          (value) => {
            signal.removeEventListener("abort", abort);
            resolve(value);
          },
          (error) => {
            signal.removeEventListener("abort", abort);
            reject(error);
          },
        );
      })
    : await lookupTask;
  return results.map((result) => result.address);
}
