// Host/URL safety classification for URLs that participant *browsers* will
// fetch — bookmark sources, unfurl preview images, favicons. Every check here
// is pure and dependency-free so the same rules run in the browser (before a
// record is created) and on the sync server (before a record is synced).
//
// DNS-dependent SSRF guards for URLs the *server* fetches live in
// apps/whiteboard-server/src/http/net-security.ts, which re-exports this
// module's primitives.

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
]);

const BLOCKED_HOST_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".home",
  ".lan",
  ".arpa",
];

const MAX_BROWSER_URL_LENGTH = 2048;

/**
 * Strip the brackets a URL keeps around an IPv6 literal. `URL.hostname` returns
 * `[::1]`, which is not a parseable address — every classifier below expects the
 * bare form.
 */
export function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

/**
 * Strict IPv4 dotted-quad: exactly four decimal octets in 0-255, no leading
 * zeros. Deliberately rejects every alternate form a browser would still
 * resolve — hex ("0x7f000001"), octal ("017700000001"), bare decimal
 * ("2130706433"), short forms ("127.1"), and zero-padded octets
 * ("127.0.0.01") — so those can never be classified as ordinary hostnames and
 * skip the private-range check.
 */
export function isStrictIpv4(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) return false;
    if (part.length > 1 && part.startsWith("0")) return false;
    return Number(part) <= 255;
  });
}

// Same octet rules as isStrictIpv4, applied to the trailing dotted-quad of an
// IPv4-mapped/compatible IPv6 literal (e.g. ::ffff:192.168.1.1).
function parseStrictIpv4Octets(value: string): number[] | null {
  if (!isStrictIpv4(value)) return null;
  return value.split(".").map(Number);
}

/**
 * Expand an IPv6 address to its full 8-group form, or return null when the
 * input is not a valid IPv6 literal. Doubles as the IPv6 validator: it rejects
 * non-hex groups, multiple `::` runs, and wrong group counts.
 */
export function normalizeIpv6(address: string): string | null {
  const lower = address.toLowerCase().trim();
  if (!lower.includes(":")) return null;

  // Handle IPv4-mapped/compatible forms like ::ffff:192.168.1.1 by folding the
  // trailing dotted-quad into two hex groups.
  if (lower.includes(".")) {
    const lastColon = lower.lastIndexOf(":");
    const octets = parseStrictIpv4Octets(lower.slice(lastColon + 1));
    if (!octets) return null;
    const hex1 = ((octets[0] << 8) | octets[1]).toString(16).padStart(4, "0");
    const hex2 = ((octets[2] << 8) | octets[3]).toString(16).padStart(4, "0");
    return normalizeIpv6(`${lower.slice(0, lastColon + 1)}${hex1}:${hex2}`);
  }

  const isHexGroup = (group: string): boolean => /^[0-9a-f]{1,4}$/.test(group);

  const compressedRuns = lower.split("::");
  if (compressedRuns.length > 2) return null;

  if (compressedRuns.length === 1) {
    const parts = lower.split(":");
    if (parts.length !== 8 || !parts.every(isHexGroup)) return null;
    return parts.map((part) => part.padStart(4, "0")).join(":");
  }

  const [leftStr, rightStr] = compressedRuns;
  const left = leftStr ? leftStr.split(":") : [];
  const right = rightStr ? rightStr.split(":") : [];
  if (!left.every(isHexGroup) || !right.every(isHexGroup)) return null;
  // `::` must stand in for at least one omitted group, so a full 8 groups plus
  // a compression run is invalid.
  const missingCount = 8 - left.length - right.length;
  if (missingCount < 1) return null;
  return [...left, ...Array(missingCount).fill("0000"), ...right]
    .map((part) => part.padStart(4, "0"))
    .join(":");
}

/** 4, 6, or 0 when the value is not an IP literal. Stricter than node:net's isIP. */
export function detectIpVersion(value: string): 0 | 4 | 6 {
  if (isStrictIpv4(value)) return 4;
  if (normalizeIpv6(value) !== null) return 6;
  return 0;
}

export function isSuspiciousHostname(hostname: string): boolean {
  // DNS names are equivalent with or without the absolute-name trailing dot.
  // Canonicalize it before applying exact and suffix blocks so `localhost.` and
  // `printer.local.` cannot bypass the browser-facing private-host guard.
  const normalized = stripIpv6Brackets(hostname.trim().toLowerCase()).replace(/\.+$/, "");
  if (!normalized) return true;
  if (BLOCKED_HOSTNAMES.has(normalized)) return true;
  if (BLOCKED_HOST_SUFFIXES.some((suffix) => normalized.endsWith(suffix))) return true;
  if (detectIpVersion(normalized) !== 0) return false;
  // A dotless string is either an intranet short name or a dotless IP encoding
  // ("0x7f000001", "2130706433"); both are refused.
  if (!normalized.includes(".")) return true;
  // Every real TLD contains a letter, so a hostname whose final label is all
  // digits is not a resolvable DNS name. What lands here is a non-canonical IPv4
  // encoding — "127.0.0.01", "127.1", "1.2.3.4.5" — which browsers still resolve
  // to a loopback/private address while detectIpVersion deliberately does not
  // classify it. Refuse rather than let it through as an ordinary hostname.
  return /^\d+$/.test(normalized.slice(normalized.lastIndexOf(".") + 1));
}

export function isPublicIpAddress(address: string): boolean {
  const version = detectIpVersion(address);
  if (version === 4) return isPublicIpv4(address);
  if (version === 6) return isPublicIpv6(address);
  return false;
}

/**
 * Whether a hostname is safe to hand to participant browsers as a URL to fetch
 * (e.g. an unfurl preview image becomes an <img src> on every screen). No DNS
 * round-trip: the browser, not the server, resolves it, so the realistic abuse
 * is a literal private/loopback/metadata address.
 *
 * isSuspiciousHostname alone is insufficient — it accepts canonical dotted-quad
 * and IPv6 literals (127.0.0.1, 169.254.169.254, ::1), so the literal-IP
 * private-range check must run too.
 */
export function isPublicBrowserHost(hostname: string): boolean {
  // A DNS absolute-name suffix is semantically irrelevant. Canonicalize every
  // trailing dot here as well as in isSuspiciousHostname so the subsequent IP
  // classifier cannot be skipped by inputs such as `127.0.0.1..`.
  const normalized = stripIpv6Brackets(hostname.trim().toLowerCase()).replace(/\.+$/, "");
  if (isSuspiciousHostname(normalized)) return false;
  if (detectIpVersion(normalized) !== 0 && !isPublicIpAddress(normalized)) return false;
  return true;
}

/**
 * Whether a URL is safe to store in a synced record that participant browsers
 * will fetch or navigate to. Bookmark sources and preview media are synced
 * verbatim, so a prefix blocklist is not enough: IPv4-mapped IPv6 literals like
 * [::ffff:7f00:1] and exotic private ranges (0/8, CGNAT 100.64/10) slip past
 * prefix checks while browsers happily connect to them.
 */
export function isSafeExternalBrowserUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_BROWSER_URL_LENGTH) {
    return false;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    return isPublicBrowserHost(url.hostname);
  } catch {
    return false;
  }
}

export function isPublicIpv4(address: string): boolean {
  const octets = parseStrictIpv4Octets(address);
  if (!octets) return false;

  const [a, b, c] = octets;
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  // 192.0.0.0/24 only (IANA reserved), not /16
  if (a === 192 && b === 0 && c === 0) return false;
  // TEST-NET-1 (RFC 5737)
  if (a === 192 && b === 0 && c === 2) return false;
  if (a === 192 && b === 168) return false;
  // 6to4 relay anycast (RFC 3068) — routes to whichever relay is nearest, so it
  // is not a meaningful fetch target and should not be reachable from here.
  if (a === 192 && b === 88 && c === 99) return false;
  // Benchmarking (RFC 2544)
  if (a === 198 && (b === 18 || b === 19)) return false;
  // TEST-NET-2 (198.51.100.0/24) and TEST-NET-3 (203.0.113.0/24) (RFC 5737)
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a >= 224) return false;
  return true;
}

function isPublicIpv6(address: string): boolean {
  // normalize before prefix checks to handle expanded forms like 0:0:0:0:0:0:0:1
  const normalized = normalizeIpv6(address);
  if (!normalized) return false; // unparseable — reject

  const groups = normalized.split(":");

  // Loopback ::1 and unspecified ::
  if (normalized === "0000:0000:0000:0000:0000:0000:0000:0001") return false;
  if (normalized === "0000:0000:0000:0000:0000:0000:0000:0000") return false;

  const g0 = parseInt(groups[0], 16);
  const g1 = parseInt(groups[1], 16);

  // ULA: fc00::/7 (first byte 0xfc–0xfd)
  if ((g0 & 0xfe00) === 0xfc00) return false;
  // Link-local: fe80::/10
  if ((g0 & 0xffc0) === 0xfe80) return false;
  // Multicast: ff00::/8
  if ((g0 & 0xff00) === 0xff00) return false;
  // Site-local (deprecated but still block): fec0::/10
  if ((g0 & 0xffc0) === 0xfec0) return false;

  // Documentation: 2001:db8::/32 (must be exact prefix match, not 2001:db80::)
  if (g0 === 0x2001 && g1 === 0x0db8) return false;
  // Teredo: 2001:0000::/32
  if (g0 === 0x2001 && g1 === 0x0000) return false;

  // NAT64: 64:ff9b::/96
  if (g0 === 0x0064 && g1 === 0xff9b) return false;

  // 6to4: 2002::/16 — check the embedded IPv4 for private addresses. The
  // address spans groups 1-2 as a.b.c.d, so all four octets come from them;
  // hardcoding the last one would silently misclassify the moment any rule
  // below /24 is added to isPublicIpv4.
  if (g0 === 0x2002) {
    const g2 = parseInt(groups[2], 16);
    if (
      !isPublicIpv4(
        `${(g1 >> 8) & 0xff}.${g1 & 0xff}.${(g2 >> 8) & 0xff}.${g2 & 0xff}`,
      )
    ) {
      return false;
    }
  }

  // IPv4-mapped: ::ffff:0:0/96 (groups 0-4 all zero, group 5 = 0xffff)
  // only block IPv4-mapped with private embedded addresses, not all ::ffff:*
  if (
    groups.slice(0, 5).every((group) => group === "0000") &&
    parseInt(groups[5], 16) === 0xffff
  ) {
    return isPublicIpv4(embeddedIpv4(groups));
  }

  // IPv4-compatible ::a.b.c.d (deprecated, RFC 4291): groups 0-5 all zero with a
  // non-zero low 32 bits, e.g. ::7f00:1 (127.0.0.1) or ::a9fe:1 (169.254.0.1).
  // The 0xffff-mapped branch above misses these because group 5 is zero here, so
  // they would otherwise fall through to the public `return true`. Validate the
  // embedded IPv4 the same way. (`::` and `::1` are already rejected above.)
  if (
    groups.slice(0, 6).every((group) => group === "0000") &&
    (groups[6] !== "0000" || groups[7] !== "0000")
  ) {
    return isPublicIpv4(embeddedIpv4(groups));
  }

  return true;
}

function embeddedIpv4(groups: string[]): string {
  const g6 = parseInt(groups[6], 16);
  const g7 = parseInt(groups[7], 16);
  return `${(g6 >> 8) & 0xff}.${g6 & 0xff}.${(g7 >> 8) & 0xff}.${g7 & 0xff}`;
}
