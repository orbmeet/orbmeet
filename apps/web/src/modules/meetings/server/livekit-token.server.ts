import { AccessToken, TrackSource } from "livekit-server-sdk";

/**
 * Token TTL for self-hosted LiveKit deployments.
 *
 * Kept deliberately short: self-hosted LiveKit does NOT support token
 * revocation (a Cloud-only feature), so a removed participant keeps a usable
 * cached token until it expires. A short TTL bounds that window; durable access
 * control is enforced server-side on each refresh (membership/capacity/status)
 * and by the `participant_joined` webhook backstop, not by the token itself.
 */
export const TOKEN_TTL_SECONDS = 5 * 60;
const TOKEN_TTL = `${TOKEN_TTL_SECONDS}s`;

export interface CreateTokenParams {
  apiKey: string;
  apiSecret: string;
  identity: string;
  name: string;
  roomName: string;
  attributes?: Record<string, string>;
  /**
   * Publishable track sources for this participant. Authority is expressed
   * entirely through this list (plus server-side enforcement); there is no
   * separate "host" grant on the token. Defaults to camera + microphone.
   */
  canPublishSources?: TrackSource[];
}

export interface LiveKitAccessResult {
  token: string;
  // TURN and STUN come from the LiveKit server during signaling.
  expiresIn: number;
}

/**
 * Create a LiveKit access token. Publish authority is the caller-supplied
 * `canPublishSources` list; the server enforces everything else.
 */
export async function createLiveKitToken({
  apiKey,
  apiSecret,
  identity,
  name,
  roomName,
  attributes,
  canPublishSources = [TrackSource.CAMERA, TrackSource.MICROPHONE],
}: CreateTokenParams): Promise<string> {
  const at = new AccessToken(apiKey, apiSecret, {
    identity,
    name,
    // Never per-call. A caller-supplied TTL is the one knob that can widen the
    // unrevocable window this module's header exists to keep narrow, and it
    // accepted any `\d+[hms]` — `999h` included — while silently falling back
    // to the default on anything it could not parse. No caller ever set it.
    ttl: TOKEN_TTL,
    attributes,
  });

  at.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish: true,
    canPublishData: true,
    canSubscribe: true,
    canUpdateOwnMetadata: false,
    roomAdmin: false,
    canPublishSources,
  });

  return at.toJwt();
}

export async function createLiveKitAccess(params: CreateTokenParams): Promise<LiveKitAccessResult> {
  const token = await createLiveKitToken(params);

  return {
    token,
    expiresIn: TOKEN_TTL_SECONDS,
  };
}
