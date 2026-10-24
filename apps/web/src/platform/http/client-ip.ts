import { logWarn } from "@/lib/logger";
import { isLocalDevelopment, type Deployment } from "./deployment";

// In production, CF-Connecting-IP is authoritative (set by Cloudflare).
// X-Forwarded-For is only trusted in local development (see
// `isLocalDevelopment`): it is trivially spoofable without a trusted proxy. Free of framework imports, so the raw /api
// dispatcher can use it without loading Start's server core.
export function getClientIPFromRequest(
  request: Request,
  deployment: Deployment | undefined,
): string {
  try {
    // CF-Connecting-IP is authoritative in production (set by Cloudflare)
    const cfIP = request.headers.get("CF-Connecting-IP");
    if (cfIP) return cfIP;
    // Only trust X-Forwarded-For in development to prevent IP spoofing
    // In production without CF-Connecting-IP, return "unknown" to fail-safe
    const isDev = isLocalDevelopment(deployment);
    if (isDev) {
      const forwarded = request.headers.get("X-Forwarded-For");
      if (forwarded) return forwarded.split(",")[0].trim();
      const realIP = request.headers.get("X-Real-IP");
      if (realIP) return realIP;
    }
    // Production without CF-Connecting-IP shouldn't happen behind Cloudflare
    if (!isDev) {
      logWarn(
        "[getClientIP] CF-Connecting-IP missing in non-dev environment — rate limiting may be unreliable",
      );
    }
    // Never turn attacker-controlled headers into independent production
    // buckets. A missing proxy identity shares one fail-closed bucket and the
    // warning above makes the deployment fault visible.
    return "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * The network a client address belongs to: an IPv4 address whole, an IPv6
 * one by its /64, which its client owns and can move within at will. Null
 * when the value is not an address (as "unknown" is).
 */
export function networkOf(clientIP: string): string | null {
  const address = clientIP.trim().toLowerCase().replace(/^::ffff:(?=\d+\.)/, "");
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(address)) return address;
  const groups = expandIPv6(address);
  return groups ? `${groups.slice(0, 4).join(":")}::/64` : null;
}

/** The eight hextets of an IPv6 address, or null when it is not one. */
function expandIPv6(address: string): string[] | null {
  if (!address.includes(":")) return null;
  const halves = address.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string) => (part === "" ? [] : part.split(":"));
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  // An IPv4-mapped tail counts as two hextets; only the leading four matter.
  const width = [...head, ...tail].reduce((sum, group) => sum + (group.includes(".") ? 2 : 1), 0);
  const missing = 8 - width;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  if (!groups.slice(0, 4).every((group) => /^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.map((group) => (group.includes(".") ? group : group.replace(/^0+(?=.)/, "")));
}
