import { describe, expect, it } from "vitest";
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
} from "jose";
import { googleHostsMailbox, verifyGoogleIdToken } from "./oauth-google.server";

const CLIENT_ID = "client.apps.googleusercontent.com";

async function signedGoogleToken(
  overrides: Record<string, unknown> = {},
) {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const publicJwk = await exportJWK(publicKey);
  const keyId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1_000);
  const token = await new SignJWT({
    email: "person@example.com",
    email_verified: true,
    name: "Person",
    ...overrides,
  })
    .setProtectedHeader({ alg: "RS256", kid: keyId })
    .setIssuer("https://accounts.google.com")
    .setAudience(CLIENT_ID)
    .setSubject("google-subject")
    .setIssuedAt(now)
    .setExpirationTime(now + 3_600)
    .sign(privateKey);
  return {
    token,
    getKey: createLocalJWKSet({
      keys: [{ ...publicJwk, kid: keyId, alg: "RS256", use: "sig" }],
    }),
  };
}

describe("Google ID token verification", () => {
  it("verifies the signature and required OIDC claims locally", async () => {
    const { token, getKey } = await signedGoogleToken();
    await expect(verifyGoogleIdToken(token, CLIENT_ID, getKey)).resolves.toEqual({
      sub: "google-subject",
      email: "person@example.com",
      name: "Person",
      picture: undefined,
      email_verified: true,
      verified_email: undefined,
      hd: undefined,
    });
  });

  it("carries the Workspace domain claim", async () => {
    const { token, getKey } = await signedGoogleToken({ email: "t@school.edu", hd: "school.edu" });
    await expect(verifyGoogleIdToken(token, CLIENT_ID, getKey)).resolves.toMatchObject({
      hd: "school.edu",
    });
  });

  it("rejects the wrong audience", async () => {
    const { token, getKey } = await signedGoogleToken();
    await expect(
      verifyGoogleIdToken(token, "another.apps.googleusercontent.com", getKey),
    ).rejects.toMatchObject({ code: "OAUTH_ERROR" });
  });

  it("rejects an unverified email", async () => {
    const { token, getKey } = await signedGoogleToken({ email_verified: false });
    await expect(
      verifyGoogleIdToken(token, CLIENT_ID, getKey),
    ).rejects.toMatchObject({ code: "OAUTH_ERROR" });
  });

  it("accepts a token without the optional name claim", async () => {
    const { token, getKey } = await signedGoogleToken({ name: undefined });
    await expect(
      verifyGoogleIdToken(token, CLIENT_ID, getKey),
    ).resolves.toMatchObject({
      sub: "google-subject",
      email: "person@example.com",
      name: undefined,
    });
  });

  it("rejects a token signed by an unknown key", async () => {
    const signed = await signedGoogleToken();
    const other = await signedGoogleToken();
    await expect(
      verifyGoogleIdToken(signed.token, CLIENT_ID, other.getKey),
    ).rejects.toMatchObject({ code: "OAUTH_ERROR" });
  });
});

describe("googleHostsMailbox", () => {
  it("trusts Gmail addresses", () => {
    expect(googleHostsMailbox({ email: "Someone@Gmail.com" })).toBe(true);
    expect(googleHostsMailbox({ email: "someone@googlemail.com." })).toBe(true);
  });

  it("trusts a Workspace account on its own domain", () => {
    expect(googleHostsMailbox({ email: "t@school.edu", hd: "School.edu" })).toBe(true);
  });

  it("does not trust an address Google only verified once", () => {
    expect(googleHostsMailbox({ email: "someone@yahoo.com" })).toBe(false);
    expect(googleHostsMailbox({ email: "t@school.edu", hd: "other.edu" })).toBe(false);
  });
});
