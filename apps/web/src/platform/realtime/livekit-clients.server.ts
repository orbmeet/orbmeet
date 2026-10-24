import "@tanstack/react-start/server-only";

import { EgressClient, RoomServiceClient } from "livekit-server-sdk";

import type { MediaNode } from "./nodes";
import { livekitHttpUrl } from "./livekit-url";
import { LIVEKIT_REQUEST_TIMEOUT_SECONDS } from "./livekit-timeouts";

// The SDK passes this through to its Twirp fetch and aborts the underlying
// request. Keeping the deadline at the transport boundary avoids the dangerous
// "caller timed out while the mutation kept running" semantics of Promise.race.
export function createRoomServiceClient(
  node: MediaNode,
  requestTimeoutSeconds = LIVEKIT_REQUEST_TIMEOUT_SECONDS,
): RoomServiceClient {
  return new RoomServiceClient(
    livekitHttpUrl(node.url),
    node.apiKey,
    node.apiSecret,
    { requestTimeout: requestTimeoutSeconds },
  );
}

export function createEgressClient(node: MediaNode): EgressClient {
  return new EgressClient(
    livekitHttpUrl(node.url),
    node.apiKey,
    node.apiSecret,
    { requestTimeout: LIVEKIT_REQUEST_TIMEOUT_SECONDS },
  );
}
