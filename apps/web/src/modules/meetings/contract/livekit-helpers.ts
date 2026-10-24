/**
 * Common LiveKit utility functions shared across hooks and server code.
 */

/**
 * Options for `RoomServiceClient.removeParticipant` when force-removing a
 * participant.
 *
 * `revokeTokenTs` invalidates the participant's outstanding token so they
 * cannot reconnect with it — but this is a **LiveKit Cloud-only** feature and a
 * no-op on self-hosted deployments. It is set here as best-effort defence in
 * depth; the authoritative controls are the D1 connection/admission state and
 * the `participant_joined` webhook backstop (which re-removes anyone whose row
 * is no longer active), plus the short token TTL. Do not rely on this alone to
 * keep a removed participant out.
 */
export function participantRemovalOptions(): { revokeTokenTs: bigint } {
  return { revokeTokenTs: BigInt(Math.floor(Date.now() / 1000)) };
}

/**
 * Detect expected errors that occur when publishing data after a LiveKit
 * connection has been closed. These are harmless and should be silenced
 * rather than logged as errors.
 */
export function isExpectedClosedPublishError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes("pc manager is closed") ||
    message.includes("unexpected connection state") ||
    message.includes("unexpectedconnectionstate") ||
    message.includes("not connected")
  );
}
