import { parseInput } from "@/lib/validation";
import "@tanstack/react-start/server-only";

import { createDb } from "@orbmeet/db";
import { accounts, verifications } from "@orbmeet/db/schema";
import { and, eq, gte } from "drizzle-orm";
import { Errors } from "@/lib/app-errors";
import { generateId } from "@/lib/ids";
import { googleCallbackSchema } from "@/modules/identity/contract/auth/schemas";
import { normalizeEmail } from "@/modules/identity/contract/auth/email-normalization";
import { logInfo } from "@/lib/logger";
import { appendCookies } from "@/platform/http/cookies.server";
import { enforceIpRateLimit } from "@/platform/http/rate-limit.server";
import { getEnv, getOptionalEnv } from "@/platform/runtime/server-runtime.server";
import { verifySessionFromRawRequest } from "./session";
import {
  decryptVerifier,
  exchangeAndVerifyGoogleCode,
} from "./oauth-google.server";
import { findOAuthStateCookie } from "./oauth-state";
import { clearOAuthStateCookies } from "./oauth-cookies";
import { isUniqueConstraintError } from "@/platform/database/db-utils";

export async function linkGoogleAccountFromCallback(
  request: Request,
  data: { code: string; state: string },
) {
  const parsed = parseInput(googleCallbackSchema, data);
  const env = await getOptionalEnv() ?? await getEnv();
  const session = await verifySessionFromRawRequest(request, env);
  if (!session) throw Errors.UNAUTHORIZED();

  const db = createDb(env.DB);
  await enforceIpRateLimit(env, "oauth-link-callback");

  const expectedStateHash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(parsed.state),
  );
  const expectedHashHex = Array.from(new Uint8Array(expectedStateHash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const cookie = request.headers.get("Cookie") ?? "";
  const stateCookie = findOAuthStateCookie({
    cookie,
    baseName: "oauth_link_state",
    expectedHashHex,
    options: { appUrl: env.APP_URL, environment: env.ENVIRONMENT },
  });
  if (!stateCookie) {
    throw Errors.OAUTH_ERROR("OAuth state mismatch");
  }
  appendCookies(clearOAuthStateCookies(env, [stateCookie]));

  const consumed = await db
    .delete(verifications)
    .where(
      and(
        eq(verifications.type, "oauth_pkce"),
        eq(verifications.identifier, `oauth-link:${parsed.state}`),
        gte(verifications.expiresAt, new Date()),
      ),
    )
    .returning();

  if (consumed.length === 0) throw Errors.OAUTH_ERROR("Invalid or expired OAuth state");

  let binding: { version: 1; userId: string; authSessionId: string } | null = null;
  try {
    binding = consumed[0].data ? JSON.parse(consumed[0].data) : null;
  } catch {
    binding = null;
  }
  if (
    !binding
    || binding.version !== 1
    || binding.userId !== session.userId
    || binding.authSessionId !== session.sessionId
  ) {
    throw Errors.OAUTH_ERROR("OAuth link session changed");
  }

  let linkCodeVerifier: string;
  try {
    linkCodeVerifier = await decryptVerifier(consumed[0].value, env.AUTH_SECRET);
  } catch {
    throw Errors.OAUTH_ERROR("Failed to verify OAuth state");
  }

  const payload = await exchangeAndVerifyGoogleCode(
    parsed.code,
    linkCodeVerifier,
    `${env.APP_URL}/api/auth/callback/google-link`,
    env,
  );

  const googleNormalized = normalizeEmail(payload.email);
  const dbUser = await db.query.users.findFirst({
    where: { id: session.userId },
    columns: { normalizedEmail: true },
  });
  if (!dbUser || googleNormalized !== dbUser.normalizedEmail) {
    throw Errors.VALIDATION("Google account email must match your account email.");
  }

  const existingAccount = await db.query.accounts.findFirst({
    where: { RAW: (row) => and(
      eq(row.providerId, "google"),
      eq(row.providerAccountId, payload.sub),
    )! },
  });
  if (existingAccount) {
    if (existingAccount.userId === session.userId) {
      return { success: true, alreadyLinked: true };
    }
    throw Errors.VALIDATION("This Google account is already linked to another user.");
  }

  try {
    await db.insert(accounts).values({
      id: generateId("ACCOUNT"),
      userId: session.userId,
      providerId: "google",
      providerAccountId: payload.sub,
    });
  } catch (err) {
    if (!isUniqueConstraintError(err)) throw err;

    const conflictedAccount = await db.query.accounts.findFirst({
      where: { RAW: (row) => and(
        eq(row.providerId, "google"),
        eq(row.providerAccountId, payload.sub),
      )! },
    });
    if (conflictedAccount?.userId === session.userId) {
      return { success: true, alreadyLinked: true };
    }
    throw Errors.VALIDATION("This Google account is already linked to another user.");
  }

  logInfo("[OAuth] Linked a Google account", { userId: session.userId, googleSubject: payload.sub });

  return { success: true };
}
