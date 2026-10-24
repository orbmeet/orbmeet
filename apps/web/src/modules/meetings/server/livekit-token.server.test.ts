import { describe, expect, it } from "vitest";
import { TrackSource } from "livekit-server-sdk";
import {
  createLiveKitAccess,
  createLiveKitToken,
  TOKEN_TTL_SECONDS,
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
    const claims = await mintToken();
    const lifetimeSeconds = (claims.exp as number) - (claims.nbf as number);
    expect(lifetimeSeconds).toBe(TOKEN_TTL_SECONDS);
    expect(TOKEN_TTL_SECONDS).toBeLessThanOrEqual(10 * 60);

    const access = await createLiveKitAccess({
      apiKey: API_KEY,
      apiSecret: API_SECRET,
      identity: "user_1",
      name: "Participant",
      roomName: "meet-meeting_1",
      // A stale caller passing the removed knob must not widen anything.
      ...({ ttl: "999h" } as Record<string, unknown>),
    });
    expect(access.expiresIn).toBe(TOKEN_TTL_SECONDS);
    const replayed = decodeClaims(access.token);
    expect((replayed.exp as number) - (replayed.nbf as number)).toBe(TOKEN_TTL_SECONDS);
  });
});
