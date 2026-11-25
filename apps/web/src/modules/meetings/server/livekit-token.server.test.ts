import { describe, expect, it } from "vitest";
import { TrackSource } from "livekit-server-sdk";
import { MEDIA_TOKEN_TTL_MS } from "./runtime/model";
import {
  createLiveKitAccess,
  createLiveKitToken,
} from "./livekit-token.server";

const API_KEY = "devkey";
const API_SECRET = "devsecretdevsecretdevsecretdevsecret";

function decodeClaims(token: string): Record<string, unknown> {
  const payload = token.split(".")[1];
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
}

async function mintToken(overrides: Partial<Parameters<typeof createLiveKitToken>[0]> = {}) {
  const token = await createLiveKitToken({
    apiKey: API_KEY,
    apiSecret: API_SECRET,
    identity: "user_1",
    name: "Participant",
    roomName: "meet-meeting_1",
    expiresAt: Date.now() + MEDIA_TOKEN_TTL_MS,
    ...overrides,
  });
  return decodeClaims(token);
}

describe("LiveKit token grants", () => {
  /**
   * Every client-side moderation check — screen-share approve/deny, hand
   * raises, admission nudges — trusts the `orbmeet.role` attribute, and the
   * meeting UI reads room state it must not be able to author. That is only
   * safe because the token withholds these two grants. Widening either one
   * silently turns the whole `modules/meetings/client` grant layer into a
   * self-promotion vector, so it is pinned here rather than left to review.
   */
  it("never lets a participant rewrite their own metadata or administer the room", async () => {
    const video = (await mintToken()).video as Record<string, unknown>;
    expect(video.canUpdateOwnMetadata).toBeFalsy();
    expect(video.roomAdmin).toBeFalsy();
    expect(video.roomCreate).toBeFalsy();
    expect(video.roomList).toBeFalsy();
    expect(video.roomRecord).toBeFalsy();
  });

  it("scopes the grant to the one room it was minted for", async () => {
    const video = (await mintToken()).video as Record<string, unknown>;
    expect(video.room).toBe("meet-meeting_1");
    expect(video.roomJoin).toBe(true);
  });

  it("expresses publish authority only through canPublishSources", async () => {
    const attendee = (await mintToken()).video as Record<string, string[]>;
    expect(attendee.canPublishSources).toEqual(["camera", "microphone"]);

    const sharer = (await mintToken({
      canPublishSources: [TrackSource.CAMERA, TrackSource.MICROPHONE, TrackSource.SCREEN_SHARE],
    })).video as Record<string, string[]>;
    expect(sharer.canPublishSources).toContain("screen_share");
  });

  /**
   * Self-hosted LiveKit cannot revoke a token, so its lifetime *is* the
   * eviction window. It is fixed at the module level for exactly that reason:
   * the per-call override this replaced accepted any `\d+[hms]`, so `999h`
   * would have minted a token outliving the meeting by a month.
   */
  it("issues a short-lived token that no caller can lengthen", async () => {
    const claims = await mintToken({ expiresAt: Date.now() + 100 * MEDIA_TOKEN_TTL_MS });
    const lifetimeSeconds = (claims.exp as number) - (claims.nbf as number);
    // The lifetime the meeting assumes when it decides a token can no longer
    // make its room.
    expect(lifetimeSeconds).toBe((MEDIA_TOKEN_TTL_MS / 1000));
    expect((MEDIA_TOKEN_TTL_MS / 1000)).toBeLessThanOrEqual(10 * 60);

    const access = await createLiveKitAccess({
      apiKey: API_KEY,
      apiSecret: API_SECRET,
      identity: "user_1",
      name: "Participant",
      roomName: "meet-meeting_1",
      expiresAt: Date.now() + MEDIA_TOKEN_TTL_MS,
      // A stale caller passing the removed knob must not widen anything.
      ...({ ttl: "999h" } as Record<string, unknown>),
    });
    expect(access.expiresIn).toBe((MEDIA_TOKEN_TTL_MS / 1000));
    const replayed = decodeClaims(access.token);
    expect((replayed.exp as number) - (replayed.nbf as number)).toBe((MEDIA_TOKEN_TTL_MS / 1000));
  });

  it("expires a token minted again for the same join when the first one does", async () => {
    // The meeting forgets its room once its newest attempt's tokens expire; a
    // repeated join's token must not outlive that.
    const issuedAt = Date.now() - 60_000;
    const access = await createLiveKitAccess({
      apiKey: API_KEY,
      apiSecret: API_SECRET,
      identity: "user_1",
      name: "Participant",
      roomName: "meet-meeting_1",
      expiresAt: issuedAt + MEDIA_TOKEN_TTL_MS,
    });
    const claims = decodeClaims(access.token);
    expect((claims.exp as number) * 1000).toBeLessThanOrEqual(issuedAt + MEDIA_TOKEN_TTL_MS);
    expect(access.expiresIn).toBeLessThanOrEqual(MEDIA_TOKEN_TTL_MS / 1000 - 60);
  });
});
