import "@tanstack/react-start/server-only";
import { Errors } from "@/lib/app-errors";
import { FIXED_RTMP_STREAM_KEY_REGEX, type StreamingPlatform } from "@/modules/meetings/contract/schemas";


type ResolvedRtmpAddress = { address: string; family: 4 | 6 };
export type RtmpHostnameResolver = (hostname: string) => Promise<ResolvedRtmpAddress[]>;

const RTMP_DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query";

function parseIntegerLiteral(value: string): bigint | null {
  const normalized = value.toLowerCase();
  if (/^0x[0-9a-f]+$/.test(normalized)) return BigInt(normalized);
  if (/^0[0-7]+$/.test(normalized)) return BigInt(`0o${normalized.slice(1)}`);
  if (/^(0|[1-9][0-9]*)$/.test(normalized)) return BigInt(normalized);
  return null;
}

function parseIpv4Address(value: string): number[] | null {
  const parts = value.toLowerCase().split(".");
  if (parts.length < 1 || parts.length > 4 || parts.some((part) => part === "")) return null;

  const values = parts.map(parseIntegerLiteral);
  if (values.some((part) => part === null)) return null;

  if (parts.length === 4) {
    if (values.some((part) => part === null || part > 255n)) return null;
    return values.map((part) => Number(part));
  }

  const head = values.slice(0, -1) as bigint[];
  const tail = values[values.length - 1];
  if (tail === null || head.some((part) => part > 255n)) return null;

  const tailBits = BigInt((5 - parts.length) * 8);
  const maxTail = (1n << tailBits) - 1n;
  if (tail > maxTail) return null;

  let packed = 0n;
  for (const part of head) packed = (packed << 8n) + part;
  packed = (packed << tailBits) + tail;
  if (packed > 0xffffffffn) return null;

  return [
    Number((packed >> 24n) & 255n),
    Number((packed >> 16n) & 255n),
    Number((packed >> 8n) & 255n),
    Number(packed & 255n),
  ];
}

const IPV6_GROUP_COUNT = 8;

/**
 * Parse an IPv6 literal into its eight 16-bit groups, expanding `::` and a
 * trailing dotted-quad (`::ffff:127.0.0.1`). Returns null when the value is not
 * a well-formed IPv6 address.
 *
 * Classification needs the numeric groups. Matching textual prefixes instead
 * silently missed whole families whose written form shares no prefix with the
 * ones that were listed — IPv4-compatible `::a.b.c.d`, site-local `fec0::/10`,
 * multicast `ff00::/8`, and 6to4 `2002::/16` all reached the egress server.
 */
function parseIpv6Address(value: string): number[] | null {
  // A zone id (`fe80::1%eth0`) never identifies a routable streaming host, and
  // it is not part of the address itself — drop it before parsing.
  const withoutZone = value.split("%")[0] ?? "";
  if (!withoutZone.includes(":")) return null;

  const halves = withoutZone.split("::");
  if (halves.length > 2) return null;

  const expand = (part: string): number[] | null => {
    if (part === "") return [];
    const tokens = part.split(":");
    const groups: number[] = [];
    for (const [index, token] of tokens.entries()) {
      // A dotted-quad is only legal as the final token, where it fills the last
      // two groups.
      if (token.includes(".")) {
        const octets = index === tokens.length - 1 ? parseIpv4Address(token) : null;
        if (!octets) return null;
        groups.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(token)) return null;
      groups.push(Number.parseInt(token, 16));
    }
    return groups;
  };

  const head = expand(halves[0] ?? "");
  const tail = halves.length === 2 ? expand(halves[1] ?? "") : [];
  if (!head || !tail) return null;

  if (halves.length === 1) {
    return head.length === IPV6_GROUP_COUNT ? head : null;
  }
  // `::` must stand for at least one elided group.
  const elided = IPV6_GROUP_COUNT - head.length - tail.length;
  if (elided < 1) return null;
  return [...head, ...Array.from({ length: elided }, () => 0), ...tail];
}

/**
 * The IPv4 destination an IPv6 address carries, for the transition mechanisms
 * that embed one. Every such address resolves to the embedded destination on
 * some stack, so it inherits the IPv4 rules rather than the IPv6 ones.
 */
function ipv6EmbeddedIpv4(groups: number[]): number[] | null {
  const trailingIpv4 = () => [
    (groups[6] >> 8) & 255,
    groups[6] & 255,
    (groups[7] >> 8) & 255,
    groups[7] & 255,
  ];
  const hasZeroPrefix = groups.slice(0, 5).every((group) => group === 0);
  // ::ffff:a.b.c.d (IPv4-mapped) and ::a.b.c.d (IPv4-compatible — deprecated,
  // but still translated to the embedded address by common resolvers).
  if (hasZeroPrefix && (groups[5] === 0xffff || groups[5] === 0)) return trailingIpv4();
  // 64:ff9b::/96 and 64:ff9b:1::/48 — the NAT64 well-known prefixes.
  if (groups[0] === 0x0064 && groups[1] === 0xff9b) return trailingIpv4();
  // 2002:a.b.c.d::/16 — 6to4 carries the IPv4 address in the next two groups.
  if (groups[0] === 0x2002) {
    return [
      (groups[1] >> 8) & 255,
      groups[1] & 255,
      (groups[2] >> 8) & 255,
      groups[2] & 255,
    ];
  }
  return null;
}

function isUnsafeIpv4Address(octets: number[]): boolean {
  const [a, b, c] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function normalizeRtmpHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

function isUnsafeIpv6Groups(groups: number[]): boolean {
  // An address carrying an IPv4 destination is judged by that destination. The
  // transition prefixes are never legitimate streaming endpoints in their own
  // right, so an embedded *public* address is refused too — matching how the
  // previous filter treated every IPv4-mapped address.
  if (ipv6EmbeddedIpv4(groups)) return true;

  const first = groups[0];
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7  unique-local
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  if ((first & 0xff00) === 0xff00) return true; // ff00::/8  multicast
  if (first === 0x2001 && groups[1] === 0x0db8) return true; // 2001:db8::/32 documentation
  if (first === 0x0100 && groups.slice(1, 4).every((group) => group === 0)) return true; // 100::/64 discard
  return false;
}

function isUnsafeIpv6Address(value: string): boolean {
  const groups = parseIpv6Address(normalizeRtmpHostname(value));
  // Reaching here means the value contains a colon but is not a well-formed
  // address. It cannot name a reachable streaming host, and letting an
  // unparseable literal through is the one failure mode this filter exists to
  // prevent — refuse it.
  if (!groups) return true;
  return isUnsafeIpv6Groups(groups);
}

function isUnsafeIpAddress(value: string): boolean {
  const normalized = normalizeRtmpHostname(value);
  if (normalized.includes(":")) return isUnsafeIpv6Address(normalized);

  const ipv4 = parseIpv4Address(normalized);
  if (ipv4) return isUnsafeIpv4Address(ipv4);
  return false;
}

function isLiteralIpAddress(value: string): boolean {
  const normalized = normalizeRtmpHostname(value);
  return Boolean(parseIpv4Address(normalized) || normalized.includes(":"));
}

function isUnsafeRtmpHostname(hostname: string): boolean {
  const normalized = normalizeRtmpHostname(hostname);

  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local")
  ) {
    return true;
  }

  return isUnsafeIpAddress(normalized);
}

export function validateCustomRtmpUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw Errors.VALIDATION("Custom stream URL must be a valid RTMPS URL");
  }

  if (parsed.protocol !== "rtmps:") {
    throw Errors.VALIDATION("Custom stream URL must start with rtmps://");
  }
  if (parsed.username || parsed.password) {
    throw Errors.VALIDATION("Custom stream URL must not include embedded credentials");
  }
  if (isUnsafeRtmpHostname(parsed.hostname)) {
    throw Errors.VALIDATION("Custom stream URL must use a public streaming host");
  }

  return parsed.toString();
}

async function resolveRtmpHostname(hostname: string): Promise<ResolvedRtmpAddress[]> {
  const records: ResolvedRtmpAddress[] = [];

  for (const [type, family] of [["A", 4], ["AAAA", 6]] as const) {
    const url = new URL(RTMP_DOH_ENDPOINT);
    url.searchParams.set("name", hostname);
    url.searchParams.set("type", type);
    const response = await fetch(url, {
      headers: { Accept: "application/dns-json" },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      throw Errors.VALIDATION("Could not verify the custom stream host");
    }
    const data = await response.json() as {
      Answer?: Array<{ type?: number; data?: unknown }>;
    };
    const expectedType = family === 4 ? 1 : 28;
    for (const answer of data.Answer ?? []) {
      if (answer.type !== expectedType || typeof answer.data !== "string") continue;
      records.push({ address: answer.data, family });
    }
  }

  return records;
}

/**
 * Best-effort SSRF first line for user-supplied RTMP destinations: rejects
 * private/reserved/link-local literals and DNS names that currently resolve to
 * them. This does NOT fully close SSRF — it resolves the hostname then hands the
 * *hostname* URL to LiveKit egress (StreamOutput has no resolved-IP field), so a
 * DNS-rebind between this check and the egress server's own resolution can still
 * point egress at an internal address. The authoritative control is network-
 * layer egress isolation on the egress host (block RFC1918 / 169.254.0.0/16 /
 * fc00::/7 / fe80::/10), applied by infra/ops (render.ts firewallRules). Keep both layers.
 */
export async function validatePublicRtmpDestination(
  value: string,
  resolver: RtmpHostnameResolver = resolveRtmpHostname,
): Promise<string> {
  const normalizedUrl = validateCustomRtmpUrl(value);
  const hostname = normalizeRtmpHostname(new URL(normalizedUrl).hostname);
  if (isLiteralIpAddress(hostname)) return normalizedUrl;

  const records = await resolver(hostname);
  if (records.length === 0) {
    throw Errors.VALIDATION("Custom stream URL must resolve to a public streaming host");
  }
  if (records.some((record) => isUnsafeIpAddress(record.address))) {
    throw Errors.VALIDATION("Custom stream URL must resolve to a public streaming host");
  }

  return normalizedUrl;
}

export async function buildRtmpUrl(platform: StreamingPlatform, streamKey: string): Promise<string> {
  const trimmed = streamKey.trim();
  const fixedHostKey = () => {
    if (!FIXED_RTMP_STREAM_KEY_REGEX.test(trimmed)) {
      throw Errors.VALIDATION("Stream key contains unsupported characters");
    }
    return trimmed;
  };
  switch (platform) {
    case "twitch":
      return `rtmps://live.twitch.tv/app/${fixedHostKey()}`;
    case "youtube":
      return `rtmps://a.rtmp.youtube.com/live2/${fixedHostKey()}`;
    case "facebook":
      return `rtmps://live-api-s.facebook.com:443/rtmp/${fixedHostKey()}`;
    case "kick":
      return `rtmps://fa723fc1b171.global-contribute.live-video.net:443/app/${fixedHostKey()}`;
    case "linkedin":
    case "instagram":
    case "tiktok":
    case "x":
    case "custom":
      return validatePublicRtmpDestination(trimmed);
  }
}
