/**
 * Who a whiteboard AI request is metered against.
 *
 * Signed-in callers are their account. A guest has no account, so the bucket
 * has to be something a guest cannot change at will: the tenant paying for the
 * meeting. An admission or connection id is neither — both are minted fresh on
 * every join, so a guest who reconnects arrives with an empty quota, and the
 * per-caller limit measured how recently they rejoined rather than how much
 * they had used.
 *
 * Guests of one tenant therefore share a bucket. That is the deliberate trade:
 * a shared limit one participant can spend is a limit; a per-caller limit that
 * resets on demand is not.
 */
export function whiteboardMeteringPrincipal(access: {
  userId: string | null;
  billingPrincipalType: "user" | "organization";
  billingPrincipalId: string;
}): string {
  return access.userId
    ? `user:${access.userId}`
    : `billing:${access.billingPrincipalType}:${access.billingPrincipalId}:guests`;
}
