import { describe, it, expect, vi } from "vitest";
import { createWhiteboardJWT, verifyWhiteboardJWT, type WhiteboardJWTClaims, type WhiteboardRole } from "./whiteboard-jwt.ts";
import type { WhiteboardRoomId } from "./whiteboard-room-id.ts";

const SECRET = "test-secret-at-least-32-chars-long!!";
const KID = "node-k1";
const KEYRING = new Map([[KID, SECRET]]);

const BASE_PAYLOAD = {
  sub: "user-abc",
  name: "Alice",
  role: "participant" as WhiteboardRole,
  capabilities: { canEditWhiteboard: false, canControlSurface: false, canManageWhiteboard: false },
  sid: "meet-xyz" as WhiteboardRoomId,
  connectionId: "conn-1",
  grantPrincipal: { type: "user", id: "user-abc" } as const,
  documentId: "whiteboard_1",
};

async function makeToken(
  overrides: Partial<typeof BASE_PAYLOAD> = {},
  expiresInSeconds = 3600
): Promise<string> {
  return createWhiteboardJWT(KEYRING, { ...BASE_PAYLOAD, ...overrides }, expiresInSeconds);
}

describe("identity claims must be distinguishable principals", () => {
  it("rejects an empty sub", async () => {
    await expect(verifyWhiteboardJWT(await makeToken({ sub: "" }), KEYRING)).rejects.toThrow(
      /non-empty/,
    );
  });

  it("rejects an empty connectionId", async () => {
    await expect(
      verifyWhiteboardJWT(await makeToken({ connectionId: "" }), KEYRING),
    ).rejects.toThrow(/non-empty/);
  });

  it("still accepts an empty name, which is display data rather than identity", async () => {
    const claims = await verifyWhiteboardJWT(await makeToken({ name: "" }), KEYRING);
    expect(claims.name).toBe("");
  });
});

describe("createWhiteboardJWT / verifyWhiteboardJWT", () => {
  it("round-trips a valid token", async () => {
    const token = await makeToken();
    const claims = await verifyWhiteboardJWT(token, KEYRING);
    expect(claims.sub).toBe("user-abc");
    expect(claims.name).toBe("Alice");
    expect(claims.role).toBe("participant");
    expect(claims.capabilities).toEqual({
      canEditWhiteboard: false,
      canControlSurface: false,
      canManageWhiteboard: false,
    });
    expect(claims.sid).toBe("meet-xyz");
    expect(claims.connectionId).toBe("conn-1");
    expect(claims.grantPrincipal).toEqual({ type: "user", id: "user-abc" });
    expect(claims.documentId).toBe("whiteboard_1");
    expect(claims.iss).toBe("orbmeet");
    expect(claims.aud).toBe("whiteboard");
  });

  it("returns only the verifier's recognized claims", async () => {
    const token = await createWhiteboardJWT(KEYRING, {
      ...BASE_PAYLOAD,
      futureAuthorizationFlag: true,
    } as typeof BASE_PAYLOAD);
    const claims = await verifyWhiteboardJWT(token, KEYRING);
    expect(claims).not.toHaveProperty("futureAuthorizationFlag");
  });

  it("accepts participant and guest identity roles", async () => {
    for (const role of ["participant", "guest"] as const) {
      const token = await makeToken({ role });
      const claims = await verifyWhiteboardJWT(token, KEYRING);
      expect(claims.role).toBe(role);
    }
  });

  it("rejects a token without explicit capabilities", async () => {
    const token = await makeToken();
    const [header, body] = token.split(".");
    const decoded = JSON.parse(atob(body.replace(/-/g, "+").replace(/_/g, "/"))) as Partial<WhiteboardJWTClaims>;
    delete decoded.capabilities;
    const tamperedBody = btoa(JSON.stringify(decoded))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const message = `${header}.${tamperedBody}`;
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signed = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
    const signedB64 = btoa(String.fromCharCode(...new Uint8Array(signed)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    await expect(verifyWhiteboardJWT(`${message}.${signedB64}`, KEYRING)).rejects.toThrow("capabilities");
  });

  it("rejects an invalid role", async () => {
    const token = await makeToken({ role: "admin" as never });
    await expect(verifyWhiteboardJWT(token, KEYRING)).rejects.toThrow("Invalid JWT role");
  });

  it("rejects a signed token whose sid is not a whiteboard room id", async () => {
    // Every route reads claims.sid as a room identity and some reach storage
    // paths with it, so the shape check belongs here rather than in one caller.
    for (const sid of ["../escape", "meet-", "room-xyz", "meet-bad/slash", ""]) {
      const token = await makeToken({ sid: sid as WhiteboardRoomId });
      await expect(verifyWhiteboardJWT(token, KEYRING)).rejects.toThrow(
        /whiteboard room id|required claims/,
      );
    }
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await makeToken();
    await expect(verifyWhiteboardJWT(token, new Map([[KID, "wrong-secret"]]))).rejects.toThrow("Invalid JWT signature");
  });

  it("names the key it was signed with, and is refused by a keyring without that key", async () => {
    const token = await makeToken();
    expect(JSON.parse(atob(token.split(".")[0].replace(/-/g, "+").replace(/_/g, "/"))).kid).toBe(KID);
    // Another node's keyring, even one holding the same secret under another id.
    await expect(verifyWhiteboardJWT(token, new Map([["other-k1", SECRET]]))).rejects.toThrow("Unknown JWT key");
    const twoKeys = new Map([["next", "n".repeat(40)], [KID, SECRET]]);
    await expect(verifyWhiteboardJWT(token, twoKeys)).resolves.toBeDefined();
  });

  it("rejects a tampered payload", async () => {
    const token = await makeToken();
    const [h, , sig] = token.split(".");
    const tampered = JSON.stringify({
      sub: "attacker",
      name: "Eve",
      role: "participant",
      capabilities: { canEditWhiteboard: true, canControlSurface: true, canManageWhiteboard: true },
      sid: "meet-xyz",
      connectionId: "conn-1",
      iss: "orbmeet",
      aud: "whiteboard",
      iat: 0,
      exp: 9999999999,
    });
    const fakePart = btoa(tampered).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    await expect(verifyWhiteboardJWT(`${h}.${fakePart}.${sig}`, KEYRING)).rejects.toThrow("Invalid JWT signature");
  });

  it("rejects an expired token", async () => {
    const token = await makeToken({}, -1);
    await expect(verifyWhiteboardJWT(token, KEYRING)).rejects.toThrow("JWT expired");
  });

  it("rejects a token with iat too far in the future (clock skew > 60s)", async () => {
    vi.useFakeTimers();
    // Create token with current (fake) time, then wind clock back 120 seconds
    // so from the verifier's perspective, iat is 120s ahead — beyond the 60s skew window
    const futureToken = await makeToken();
    vi.setSystemTime(Date.now() - 120_000);
    await expect(verifyWhiteboardJWT(futureToken, KEYRING)).rejects.toThrow("JWT issued-at is in the future");
    vi.useRealTimers();
  });

  it("accepts a token with iat within the 60s clock skew window", async () => {
    vi.useFakeTimers();
    const futureToken = await makeToken();
    vi.setSystemTime(Date.now() - 30_000);
    await expect(verifyWhiteboardJWT(futureToken, KEYRING)).resolves.toBeDefined();
    vi.useRealTimers();
  });

  it("rejects a token with lifetime exceeding 24h", async () => {
    const token = await makeToken({}, 25 * 3600);
    await expect(verifyWhiteboardJWT(token, KEYRING)).rejects.toThrow("JWT lifetime is too long");
  });

  it("rejects a token that expires before it was issued (REVIEW #30)", async () => {
    const enc = new TextEncoder();
    const b64 = (value: string) => btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const header = b64(JSON.stringify({ alg: "HS256", typ: "JWT", kid: KID }));
    const now = Math.floor(Date.now() / 1000);
    const payload = b64(JSON.stringify({ ...BASE_PAYLOAD, iss: "orbmeet", aud: "whiteboard", iat: now + 30, exp: now + 10 }));
    const message = `${header}.${payload}`;
    const key = await crypto.subtle.importKey("raw", enc.encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
    const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    await expect(verifyWhiteboardJWT(`${message}.${sigB64}`, KEYRING)).rejects.toThrow("expires before it was issued");
  });

  it("rejects a token with wrong issuer", async () => {
    // Forge a token with wrong iss by signing it with the same secret but wrong iss field.
    // We do this by creating a valid token and then manually constructing one with bad iss.
    const enc = new TextEncoder();
    const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT", kid: KID })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const now = Math.floor(Date.now() / 1000);
    const payload = btoa(JSON.stringify({ ...BASE_PAYLOAD, iss: "evil", aud: "whiteboard", iat: now, exp: now + 3600 })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const message = `${header}.${payload}`;
    const key = await crypto.subtle.importKey("raw", enc.encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
    const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    await expect(verifyWhiteboardJWT(`${message}.${sigB64}`, KEYRING)).rejects.toThrow("Invalid JWT issuer");
  });

  it("rejects a token with wrong audience (string)", async () => {
    const enc = new TextEncoder();
    const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT", kid: KID })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const now = Math.floor(Date.now() / 1000);
    const payload = btoa(JSON.stringify({ ...BASE_PAYLOAD, iss: "orbmeet", aud: "other-service", iat: now, exp: now + 3600 })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const message = `${header}.${payload}`;
    const key = await crypto.subtle.importKey("raw", enc.encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
    const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    await expect(verifyWhiteboardJWT(`${message}.${sigB64}`, KEYRING)).rejects.toThrow("Invalid JWT audience");
  });

  it("accepts whiteboard in an audience array", async () => {
    const enc = new TextEncoder();
    const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT", kid: KID })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const now = Math.floor(Date.now() / 1000);
    const payload = btoa(JSON.stringify({ ...BASE_PAYLOAD, iss: "orbmeet", aud: ["whiteboard", "other"], iat: now, exp: now + 3600 })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const message = `${header}.${payload}`;
    const key = await crypto.subtle.importKey("raw", enc.encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
    const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const claims = await verifyWhiteboardJWT(`${message}.${sigB64}`, KEYRING);
    expect(claims.aud).toEqual(["whiteboard", "other"]);
  });

  it("rejects a name with control characters", async () => {
    const token = await makeToken({ name: "Alice\x01Evil" });
    await expect(verifyWhiteboardJWT(token, KEYRING)).rejects.toThrow("invalid characters");
  });

  it("rejects a name with C1 control characters", async () => {
    const token = await makeToken({ name: "Alice\u0085Evil" });
    await expect(verifyWhiteboardJWT(token, KEYRING)).rejects.toThrow("invalid characters");
  });

  it("rejects a name exceeding 256 characters", async () => {
    const token = await makeToken({ name: "A".repeat(257) });
    await expect(verifyWhiteboardJWT(token, KEYRING)).rejects.toThrow("invalid characters or is too long");
  });

  it("bounds identity and service claims", async () => {
    await expect(verifyWhiteboardJWT(
      await makeToken({ sub: "u".repeat(257) }),
      KEYRING,
    )).rejects.toThrow(/valid non-empty identities/);
    await expect(verifyWhiteboardJWT(
      await createWhiteboardJWT(KEYRING, { ...BASE_PAYLOAD, service: "s".repeat(65) }),
      KEYRING,
    )).rejects.toThrow("Invalid JWT service claim");
  });

  it("accepts a name of exactly 256 characters", async () => {
    const token = await makeToken({ name: "A".repeat(256) });
    const claims = await verifyWhiteboardJWT(token, KEYRING);
    expect(claims.name).toHaveLength(256);
  });

  it("rejects a malformed token (not three parts)", async () => {
    await expect(verifyWhiteboardJWT("not.a.valid.jwt.here", KEYRING)).rejects.toThrow("Invalid JWT format");
    await expect(verifyWhiteboardJWT("onlytwoparts.foo", KEYRING)).rejects.toThrow("Invalid JWT format");
  });

  it("rejects non-HS256 algorithm", async () => {
    const enc = new TextEncoder();
    const header = btoa(JSON.stringify({ alg: "RS256", typ: "JWT", kid: KID })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const now = Math.floor(Date.now() / 1000);
    const payload = btoa(JSON.stringify({ ...BASE_PAYLOAD, iss: "orbmeet", aud: "whiteboard", iat: now, exp: now + 3600 })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const message = `${header}.${payload}`;
    const key = await crypto.subtle.importKey("raw", enc.encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
    const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    await expect(verifyWhiteboardJWT(`${message}.${sigB64}`, KEYRING)).rejects.toThrow("Invalid JWT algorithm");
  });

  it("includes optional service claim when provided", async () => {
    const token = await createWhiteboardJWT(KEYRING, { ...BASE_PAYLOAD, service: "recorder" });
    const claims = await verifyWhiteboardJWT(token, KEYRING);
    expect(claims.service).toBe("recorder");
  });

  it("rejects an empty document identity", async () => {
    await expect(verifyWhiteboardJWT(await makeToken({ documentId: "" }), KEYRING))
      .rejects.toThrow("Invalid JWT document id");
  });
});
