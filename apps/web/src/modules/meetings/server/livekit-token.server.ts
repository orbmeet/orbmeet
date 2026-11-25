import { AccessToken, TrackSource } from "livekit-server-sdk";
import { MEDIA_TOKEN_TTL_MS } from "./runtime/model";

/**
 * Token TTL for self-hosted LiveKit deployments.
 *
 * Kept deliberately short: self-hosted LiveKit does NOT support token
 * revocation (a Cloud-only feature), so a removed participant keeps a usable
 * cached token until it expires. A short TTL bounds that window; durable access
 * control is enforced server-side on each refresh (membership/capacity/status)
 * and by the `participant_joined` webhook backstop, not by the token itself.
 */
const TOKEN_TTL_SECONDS = MEDIA_TOKEN_TTL_MS / 1000;

export interface CreateTokenParams {
  apiKey: string;
  apiSecret: string;
  identity: string;
  name: string;
  roomName: string;
  /**
   * When the token stops admitting, in epoch ms: the attempt's own expiry, so
   * a token minted again for the same join expires with the first. It can
   * only shorten the lifetime, never extend it past TOKEN_TTL_SECONDS.
   */
  expiresAt: number;
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
  expiresAt,
  attributes,
  canPublishSources = [TrackSource.CAMERA, TrackSource.MICROPHONE],
}: CreateTokenParams): Promise<string> {
  const at = new AccessToken(apiKey, apiSecret, {
    identity,
    name,
    // Never longer than TOKEN_TTL_SECONDS: a longer lifetime is the one knob
    // that can widen the unrevocable window this module's header exists to
    // keep narrow.
    ttl: ttlSecondsUntil(expiresAt),
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

/** Whole seconds from now until `expiresAt`, within (0, TOKEN_TTL_SECONDS]. */
function ttlSecondsUntil(expiresAt: number): number {
  return Math.min(TOKEN_TTL_SECONDS, Math.max(1, Math.floor((expiresAt - Date.now()) / 1000)));
}

export async function createLiveKitAccess(params: CreateTokenParams): Promise<LiveKitAccessResult> {
  const expiresIn = ttlSecondsUntil(params.expiresAt);
  const token = await createLiveKitToken(params);

  return {
    token,
    expiresIn,
  };
}
