/**
 * Server implementations for the identity login/session RPC surface. Split
 * from `login.functions.ts` so the RPC declaration file carries no DB/Drizzle imports
 * and stays safe to pull into client route graphs for its handles.
 */
import { getRequest } from "@tanstack/react-start/server";
import { createDb } from "@orbmeet/db";
import { devices, sessions } from "@orbmeet/db/schema";
import {
  SESSION_EXPIRY_MS,
  SESSION_EXPIRY_SECONDS,
  SESSION_ABSOLUTE_EXPIRY_MS,
} from "@/modules/identity/contract/auth/constants";
import { generateId } from "@/lib/ids";
import type * as v from "valibot";
import { Errors, createValidationError } from "@/lib/app-errors";
import { eq, inArray, or } from "drizzle-orm";
import {
  otpVerifySchema,
  resendOtpSchema,
} from "@/modules/identity/contract/auth/schemas";
import { generateSessionToken, hashSessionToken } from "@/platform/crypto/tokens.server";
import { getRunChanges } from "@/platform/database/db-utils";
import { appendCookies, createCookieString, getCookieValue, sessionTokensFromCookie } from "@/platform/http/cookies.server";
import { getClientIP } from "@/platform/http/client-ip.server";
import { enforceIpRateLimit, enforceRateLimit } from "@/platform/http/rate-limit.server";
import { getEnv } from "@/platform/runtime/server-runtime.server";
import {
  enforceSessionCapStatement,
  getRememberedUserFromRequest,
  getSessionFromRequest,
  rememberDevice,
  sanitizeUser,
} from "./session";
import {
  consumeEmailAuthFlowStatement,
  emailAuthFlowLiveSql,
  loadEmailAuthFlow,
  resendEmailAuthFlowCode,
  verifyEmailAuthFlowCode,
} from "./email-flow";
import {
  insertActiveAccountSessionStatement,
  insertDeletionResumeSessionStatement,
  DELETION_RECOVERY_SESSION_TTL_SECONDS,
} from "./session-issuance";
import { clearOAuthFlowCookies } from "./oauth-cookies";

export async function verifyLoginOtpImpl({ data }: { data: v.InferOutput<typeof otpVerifySchema> }) {
  const request = getRequest();
  const env = await getEnv();
  const db = createDb(env.DB);

  await enforceIpRateLimit(env, "login-otp-verify");
  const flow = await loadEmailAuthFlow(db, "otp_login", data.flowToken);
  if (!flow || !flow.data.userId || !flow.data.recipientEmail) {
    throw createValidationError("Invalid or expired code.");
  }
  await enforceRateLimit(env, `login-otp-verify:${flow.data.normalizedEmail}`, true);
  await verifyEmailAuthFlowCode(db, env, "otp_login", flow, data.otp);

  const user = await db.query.users.findFirst({ where: { id: flow.data.userId } });
  if (!user) throw Errors.UNAUTHORIZED();

  // An account whose deletion already started fails every ordinary issuance
  // (the statement below fences on a null marker), which would strand the
  // account behind its own auth gate forever. Detect the gate here and issue
  // the deletion-resume session instead: the same fenced-insert shape, but it
  // inserts only while the gate is closed, and the resulting session resolves
  // exclusively through the recovery surface and the deletion endpoint.
  const deletionPending = user.deletionStartedAt !== null;
  const recoveryTtlSeconds = DELETION_RECOVERY_SESSION_TTL_SECONDS;

  const sessionId = generateId("SESSION");
  const sessionToken = generateSessionToken();
  const sessionTokenHash = await hashSessionToken(sessionToken);
  const nowMs = Date.now();
  const nowSeconds = Math.floor(nowMs / 1000);
  const expiresAtSeconds = deletionPending
    ? nowSeconds + recoveryTtlSeconds
    : Math.floor((nowMs + SESSION_EXPIRY_MS) / 1000);
  const absoluteExpiresAtSeconds = deletionPending
    ? nowSeconds + recoveryTtlSeconds
    : Math.floor((nowMs + SESSION_ABSOLUTE_EXPIRY_MS) / 1000);
  const ipAddress = getClientIP();
  const userAgent = request.headers.get("User-Agent")?.slice(0, 500) ?? null;
  const flowExists = emailAuthFlowLiveSql(flow, new Date(nowMs));
  const sessionInput = {
    id: sessionId,
    tokenHash: sessionTokenHash,
    userId: user.id,
    expiresAtSeconds,
    absoluteExpiresAtSeconds,
    ipAddress,
    userAgent,
    createdAtSeconds: nowSeconds,
    additionalGate: flowExists,
  };
  const insertSession = deletionPending
    ? insertDeletionResumeSessionStatement(db, sessionInput)
    : insertActiveAccountSessionStatement(db, sessionInput);
  const [insertResult] = await db.batch([
    insertSession,
    consumeEmailAuthFlowStatement(db, flow, new Date(nowMs)),
    enforceSessionCapStatement(db, user.id),
  ]);
  if (getRunChanges(insertResult) !== 1) {
    throw createValidationError("Invalid or expired code.");
  }

  // A remembered-device cookie cannot resolve a deletion-gated account
  // anyway (the lookup excludes gated users), so do not mint a dead row.
  if (!deletionPending) {
    await rememberDevice(db, env, user.id, sessionId).catch(() => undefined);
  }
  appendCookies([
    createCookieString("session", sessionToken, SESSION_EXPIRY_SECONDS, {
      appUrl: env.APP_URL,
      environment: env.ENVIRONMENT,
    }),
  ]);
  return {
    user: sanitizeUser(user),
    deletionPending,
  };
}

export async function resendLoginOtpImpl({ data }: { data: v.InferOutput<typeof resendOtpSchema> }) {
  const env = await getEnv();
  const db = createDb(env.DB);
  await enforceIpRateLimit(env, "login-otp-resend");

  const flow = await loadEmailAuthFlow(db, "otp_login", data.flowToken);
  if (!flow) throw createValidationError("Authentication flow expired. Please start again.");
  await enforceRateLimit(env, `login-otp-resend:${flow.data.normalizedEmail}`, true);
  const resent = await resendEmailAuthFlowCode(db, env, {
    type: "otp_login",
    deliveryPurpose: "login",
    flowToken: data.flowToken,
  });
  return { resent };
}

export async function getSessionImpl() {
  const session = await getSessionFromRequest();
  return session ? { user: session.user } : null;
}

export async function getRememberedUserImpl() {
  return getRememberedUserFromRequest();
}

export async function logoutImpl() {
  const request = getRequest();
  const env = await getEnv();
  const db = createDb(env.DB);
  await enforceIpRateLimit(env, "logout");
  const cookie = request.headers.get("Cookie");
  const sessionTokens = sessionTokensFromCookie(cookie, { appUrl: env.APP_URL, environment: env.ENVIRONMENT });
  const rememberedToken = getCookieValue(cookie, "device", { appUrl: env.APP_URL, environment: env.ENVIRONMENT });

  if (sessionTokens.length > 0) {
    const tokenHashes = await Promise.all(sessionTokens.map(hashSessionToken));
    await db
      .delete(sessions)
      .where(
        or(
          inArray(sessions.tokenHash, tokenHashes),
          inArray(sessions.previousTokenHash, tokenHashes),
        ),
      );
  }
  if (rememberedToken) {
    const rememberedTokenHash = await hashSessionToken(rememberedToken);
    await db.delete(devices).where(eq(devices.tokenHash, rememberedTokenHash));
  }

  appendCookies([
    createCookieString("session", "", 0, {
      appUrl: env.APP_URL,
      environment: env.ENVIRONMENT,
    }),
    createCookieString("device", "", 0, {
      appUrl: env.APP_URL,
      environment: env.ENVIRONMENT,
    }),
    ...clearOAuthFlowCookies(env, cookie),
  ]);
  return { success: true };
}
