import "@tanstack/react-start/server-only";
import { hmacSha256Hex } from "@/platform/crypto/tokens.server";
import { networkOf } from "@/platform/http/client-ip";

/**
 * The network a guest joined one meeting from, as an opaque key: what a
 * removal bars, since a guest has no identity that outlives their cookie.
 *
 * An IPv6 client owns at least its /64 and can move within it at will, so the
 * key names the prefix, not the address. Keyed by the meeting and a server
 * secret, so the coordinator's state holds nothing that maps back to an
 * address or links one meeting's guests to another's. Null when the client's
 * address is unknown: barring that would bar every guest at once.
 */
export async function guestNetworkKey(secret: string, meetingId: string, clientIP: string): Promise<string | null> {
  const network = networkOf(clientIP);
  return network ? hmacSha256Hex(secret, `meeting-guest-network:${meetingId}:${network}`) : null;
}
