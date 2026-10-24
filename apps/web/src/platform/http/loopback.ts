/**
 * Whether a `URL#hostname` names this machine. `URL` keeps the brackets on an
 * IPv6 literal, so the IPv6 loopback reads `[::1]`, never `::1`.
 */
export function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/** Whether `value` parses as a URL on this machine. Unparseable input is not loopback. */
export function isLoopbackUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    return isLoopbackHostname(new URL(value).hostname);
  } catch {
    return false;
  }
}
