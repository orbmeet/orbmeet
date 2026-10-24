/**
 * Server implementations behind the RPC declarations in this directory.
 * Split from the sibling RPC file so the declaration file carries no
 * DB/Drizzle imports and stays safe to include in client route graphs.
 */

import type { StepUpBody } from "@/modules/identity/contract/auth/schemas";
import { createDb } from "@orbmeet/db";
import { encodeBase64Url } from "@orbmeet/primitives";
import { accounts, verifications } from "@orbmeet/db/schema";
import { eq, and } from "drizzle-orm";
import { getEnv } from "@/platform/runtime/server-runtime.server";
import { createCookieString, appendCookies } from "@/platform/http/cookies.server";
import { enforceIpRateLimit } from "@/platform/http/rate-limit.server";
import { Errors } from "@/lib/app-errors";
import type { Database } from "@orbmeet/db";
import { oauthStateCookieName, type OAuthStateCookieBase } from "./oauth-state";
import { authorizeSensitiveAction } from "./step-up.server";
import { logInfo } from "@/lib/logger";
import { sanitizeInternalRedirect } from "@/modules/identity/contract/safe-redirect";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { AuthFnContext } from "@/app/bootstrap/middleware";
import type { GetGoogleAuthUrlInput } from "./oauth-google.functions";

// ─── Shared OAuth helpers ─────────────────────────────────────────────

/**
 * Generate a PKCE code verifier/challenge, store the verifier in the DB keyed
 * as `${identifierPrefix}:${state}`, and bind the state to the browser session
 * via an HttpOnly cookie. Returns the state and code challenge for use in the
 * authorization URL.
 */
/**
 * Encrypt a string value using AES-256-GCM, keyed from AUTH_SECRET.
 * Returns base64(iv || ciphertext) for compact DB storage.
 * An attacker with only DB read access cannot decrypt without AUTH_SECRET.
 */
async function encryptVerifier(value: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  // Derive a 256-bit AES key from the server secret using SHA-256
  const rawKey = await crypto.subtle.digest("SHA-256", enc.encode(secret));
  const aesKey = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    aesKey,
    enc.encode(value),
  );
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return btoa(String.fromCharCode(...combined));
}

/**
 * Decrypt a value encrypted by encryptVerifier.
 */
export async function decryptVerifier(encrypted: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const combined = new Uint8Array(
    atob(encrypted)
      .split("")
      .map((c) => c.charCodeAt(0)),
  );
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);
  const rawKey = await crypto.subtle.digest("SHA-256", enc.encode(secret));
  const aesKey = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["decrypt"]);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, aesKey, ciphertext);
  return new TextDecoder().decode(plaintext);
}

async function initPkceFlow(
  db: Database,
  env: Env,
  identifierPrefix: string,
  cookieName: OAuthStateCookieBase,
  verificationData?: string,
): Promise<{ state: string; codeChallenge: string }> {
  const encoder = new TextEncoder();
  const state = crypto.randomUUID();
  const codeVerifier = crypto.randomUUID() + crypto.randomUUID();
  const identifier = `${identifierPrefix}:${state}`;

  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(codeVerifier));
  const codeChallenge = encodeBase64Url(new Uint8Array(digest));

  // Encrypt the code verifier before storage so a DB read alone cannot recover it.
  // The AUTH_SECRET acts as the encryption key — attackers without it cannot decrypt.
  const encryptedVerifier = await encryptVerifier(codeVerifier, env.AUTH_SECRET);

  const now = new Date();
  const expiresAt = new Date(now.getTime() + 10 * 60 * 1000);
  await db
    .insert(verifications)
    .values({
      id: crypto.randomUUID(),
      type: "oauth_pkce" as const,
      identifier,
      value: encryptedVerifier,
      data: verificationData ?? null,
      expiresAt,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [verifications.type, verifications.identifier],
      set: {
        value: encryptedVerifier,
        data: verificationData ?? null,
        expiresAt,
        updatedAt: now,
      },
    });

  const stateHash = await crypto.subtle.digest("SHA-256", encoder.encode(state));
  const stateHashHex = Array.from(new Uint8Array(stateHash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  // One cookie per flow means two responses that were initiated from the same
  // Cookie header cannot overwrite each other's state set when they complete
  // out of order in separate tabs.
  appendCookies([
    createCookieString(oauthStateCookieName(cookieName, stateHashHex), stateHashHex, 600, {
      appUrl: env.APP_URL,
      environment: env.ENVIRONMENT,
      path: "/",
    }),
  ]);

  return { state, codeChallenge };
}

export type GoogleTokenPayload = {
  sub: string;
  email: string;
  name?: string;
  picture?: string;
  email_verified?: boolean | string;
  verified_email?: boolean | string;
  /** The Google Workspace domain, present only for Workspace accounts. */
  hd?: string;
};

const GOOGLE_MAIL_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

/**
 * Whether Google hosts the mailbox behind the token's email, so a verified
 * Google sign-in proves control of that address as strongly as an emailed
 * code does. True for Gmail and for a Workspace account on its own domain.
 * A consumer Google account registered with another provider's address
 * (`someone@yahoo.com`) was verified once, possibly long ago, and proves
 * nothing about who reads that mailbox today.
 */
export function googleHostsMailbox(payload: Pick<GoogleTokenPayload, "email" | "hd">): boolean {
  const domain = payload.email.toLowerCase().trim().split("@").pop()?.replace(/\.$/, "") ?? "";
  if (GOOGLE_MAIL_DOMAINS.has(domain)) return true;
  return typeof payload.hd === "string" && payload.hd.toLowerCase() === domain;
}

const googleJwks = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"), {
  timeoutDuration: 5_000,
  cooldownDuration: 30_000,
  cacheMaxAge: 6 * 60 * 60 * 1_000,
});

/**
 * Verify a Google ID token locally against Google's rotating, cached JWKS.
 * Google's tokeninfo endpoint is a debugging facility and adds a throttled
 * network round trip to every production sign-in; the OIDC contract is the
 * signed JWT plus issuer, audience, and lifetime validation performed here.
 */
export async function verifyGoogleIdToken(
  idToken: string,
  clientId: string,
  getKey: JWTVerifyGetKey = googleJwks,
): Promise<GoogleTokenPayload> {
  try {
    const { payload } = await jwtVerify(idToken, getKey, {
      algorithms: ["RS256"],
      issuer: ["https://accounts.google.com", "accounts.google.com"],
      audience: clientId,
      requiredClaims: ["iss", "sub", "aud", "exp", "iat"],
      clockTolerance: 5,
    });
    const emailVerified = payload.email_verified ?? payload.verified_email;
    if (
      typeof payload.sub !== "string" ||
      payload.sub.length === 0 ||
      payload.sub.length > 255 ||
      typeof payload.email !== "string" ||
      payload.email.length === 0 ||
      (emailVerified !== true && emailVerified !== "true")
    ) {
      throw new Error("Google ID token is missing required identity claims");
    }
    return {
      sub: payload.sub,
      email: payload.email,
      name: typeof payload.name === "string" && payload.name.length > 0 ? payload.name : undefined,
      picture: typeof payload.picture === "string" ? payload.picture : undefined,
      email_verified: payload.email_verified as boolean | string | undefined,
      verified_email: payload.verified_email as boolean | string | undefined,
      hd: typeof payload.hd === "string" && payload.hd.length > 0 ? payload.hd : undefined,
    };
  } catch {
    throw Errors.OAUTH_ERROR("Failed to verify ID token");
  }
}

function looksUnset(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase() ?? "";
  return (
    normalized.length === 0 ||
    normalized.includes("your-") ||
    normalized.includes("example") ||
    normalized.includes("placeholder")
  );
}

function assertGoogleOAuthConfigured(
  env: Env,
): asserts env is Env & {
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
} {
  const clientId = env.GOOGLE_CLIENT_ID;
  const clientSecret = env.GOOGLE_CLIENT_SECRET;
  if (
    looksUnset(clientId) ||
    looksUnset(clientSecret) ||
    !clientId?.trim().endsWith(".apps.googleusercontent.com")
  ) {
    throw Errors.CONFIG_ERROR(
      "Google sign-in is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in apps/web/.dev.vars.",
    );
  }
}

/**
 * Exchange an authorization code for a Google ID token, verify it, and return
 * the validated user info payload.
 */
export async function exchangeAndVerifyGoogleCode(
  code: string,
  codeVerifier: string,
  redirectUri: string,
  env: Env,
): Promise<GoogleTokenPayload> {
  assertGoogleOAuthConfigured(env);
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      code_verifier: codeVerifier,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!tokenRes.ok) throw Errors.OAUTH_ERROR("Failed to exchange code for tokens");

  const tokens = (await tokenRes.json()) as { id_token?: unknown };
  if (typeof tokens.id_token !== "string" || tokens.id_token.length === 0) {
    throw Errors.OAUTH_ERROR("Google did not return an ID token");
  }
  return verifyGoogleIdToken(tokens.id_token, env.GOOGLE_CLIENT_ID);
}

/**
 * Get Google OAuth authorization URL with PKCE
 */
export async function getGoogleAuthUrlImpl({
  data,
}: {
  data: GetGoogleAuthUrlInput;
}) {
  const env = await getEnv();
  assertGoogleOAuthConfigured(env);

  const db = createDb(env.DB);

  await enforceIpRateLimit(env, "oauth-init");

  const redirectTo = sanitizeInternalRedirect(data.redirectTo) ?? null;
  const { state, codeChallenge } = await initPkceFlow(
    db,
    env,
    "oauth",
    "oauth_state",
    JSON.stringify({ version: 1, redirectTo }),
  );

  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: `${env.APP_URL}/api/auth/callback/google`,
    response_type: "code",
    scope: "openid email profile",
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    access_type: "online",
  });

  return {
    url: `https://accounts.google.com/o/oauth2/v2/auth?${params}`,
    state,
  };
}

/**
 * Get Google OAuth URL for account linking (requires auth)
 */
export async function getGoogleLinkUrlImpl({
  data,
  context: { user, authSessionId, env, db },
}: {
  data: StepUpBody;
  context: AuthFnContext;
}) {
  await enforceIpRateLimit(env, "oauth-link-init");
  assertGoogleOAuthConfigured(env);
  await authorizeSensitiveAction(db, env, {
    credential: data.credential,
    userId: user.id,
    authSessionId,
    action: "google_link",
  });

  const { state, codeChallenge } = await initPkceFlow(
    db,
    env,
    "oauth-link",
    "oauth_link_state",
    JSON.stringify({ version: 1, userId: user.id, authSessionId }),
  );

  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: `${env.APP_URL}/api/auth/callback/google-link`,
    response_type: "code",
    scope: "openid email profile",
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    // Linking reads only the ID token, so it asks for no offline access (a
    // refresh token nothing would store).
    access_type: "online",
    prompt: "consent",
  });

  return {
    url: `https://accounts.google.com/o/oauth2/v2/auth?${params}`,
    state,
  };
}

/**
 * Unlink Google account from current user
 */
export async function unlinkGoogleAccountImpl({
  data,
  context: { user, authSessionId, env, db },
}: {
  data: StepUpBody;
  context: AuthFnContext;
}) {
  await enforceIpRateLimit(env, "oauth-unlink");
  const linked = await db.query.accounts.findFirst({
    where: {
      RAW: (row) => and(eq(row.userId, user.id), eq(row.providerId, "google"))!,
    },
    columns: { id: true },
  });
  if (!linked) throw Errors.VALIDATION("No Google account linked.");
  await authorizeSensitiveAction(db, env, {
    credential: data.credential,
    userId: user.id,
    authSessionId,
    action: "google_unlink",
  });
  const deleted = await db
    .delete(accounts)
    .where(and(eq(accounts.userId, user.id), eq(accounts.providerId, "google")))
    .returning();

  if (deleted.length === 0) throw Errors.CONFLICT("Google account link changed.");

  logInfo("[OAuth] Unlinked a Google account", { userId: user.id });

  return { success: true };
}

/**
 * Get linked accounts for current user
 */
export async function getLinkedAccountsImpl({ context: { user, db } }: { context: AuthFnContext }) {
  const linkedAccounts = await db.query.accounts.findMany({
    where: { userId: user.id },
    columns: {
      providerId: true,
      linkedAt: true,
    },
  });

  return linkedAccounts.map((acc) => ({
    providerId: acc.providerId,
    linkedAt: acc.linkedAt,
  }));
}
