/**
 * Server implementations behind the RPC declarations in this directory.
 * Split from the sibling RPC file so the declaration file carries no
 * DB/Drizzle imports and stays safe to include in client route graphs.
 */

import { getRequest } from "@tanstack/react-start/server";
import { createDb } from "@orbmeet/db";
import { sessions, users, verifications } from "@orbmeet/db/schema";
import {
  SESSION_EXPIRY_MS,
  SESSION_EXPIRY_SECONDS,
  SESSION_ABSOLUTE_EXPIRY_MS,
} from "@/modules/identity/contract/auth/constants";
import { generateId } from "@/lib/ids";
import {
  otpVerifySchema,
  resendOtpSchema,
} from "@/modules/identity/contract/auth/schemas";
import { createValidationError } from "@/lib/app-errors";
import { and, sql } from "drizzle-orm";
import { generateSessionToken, hashSessionToken } from "@/platform/crypto/tokens.server";
import { getRunChanges, isUniqueConstraintError } from "@/platform/database/db-utils";
import { appendCookies, createCookieString } from "@/platform/http/cookies.server";
import { getClientIP } from "@/platform/http/client-ip.server";
import { enforceIpRateLimit, enforceRateLimit } from "@/platform/http/rate-limit.server";
import { getEnv } from "@/platform/runtime/server-runtime.server";
import { enforceSessionCapStatement, rememberDevice, sanitizeUser } from "./session";
import {
  consumeEmailAuthFlowStatement,
  emailAuthFlowLiveSql,
  loadEmailAuthFlow,
  resendEmailAuthFlowCode,
  verifyEmailAuthFlowCode,
} from "./email-flow";
import { preparePasskeyRegistrationGrant } from "./passkey-registration-grant";
import type * as v from "valibot";

export async function verifyOtpImpl({ data }: { data: v.InferOutput<typeof otpVerifySchema> }) {
  const request = getRequest();
  const env = await getEnv();
  const db = createDb(env.DB);

  await enforceIpRateLimit(env, "otp-verify");
  const flow = await loadEmailAuthFlow(db, "otp_signup", data.flowToken);
  if (!flow || !flow.data.recipientEmail || !flow.data.name) {
    throw createValidationError("Invalid or expired code.");
  }
  await enforceRateLimit(env, `otp-verify:${flow.data.normalizedEmail}`, true);
  await verifyEmailAuthFlowCode(db, env, "otp_signup", flow, data.otp);

  const now = new Date();
  const userId = generateId("USER");
  const sessionId = generateId("SESSION");
  const sessionToken = generateSessionToken();
  const sessionTokenHash = await hashSessionToken(sessionToken);
  const sessionNow = Date.now();
  const expiresAt = new Date(sessionNow + SESSION_EXPIRY_MS);
  const absoluteExpiresAt = new Date(sessionNow + SESSION_ABSOLUTE_EXPIRY_MS);
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const expiresAtSeconds = Math.floor(expiresAt.getTime() / 1000);
  const absoluteExpiresAtSeconds = Math.floor(absoluteExpiresAt.getTime() / 1000);
  const passkeyGrant = await preparePasskeyRegistrationGrant(userId, sessionId, now);
  const passkeyGrantExpiresAtSeconds = Math.floor(passkeyGrant.expiresAt.getTime() / 1000);
  const userRecord: typeof users.$inferInsert = {
    id: userId,
    email: flow.data.recipientEmail,
    normalizedEmail: flow.data.normalizedEmail,
    name: flow.data.name,
    image: null,
    plan: "free",
    role: "user",
    createdAt: now,
    updatedAt: now,
  };

  try {
    const flowExists = emailAuthFlowLiveSql(flow, now);
    const insertUser = db.insert(users).select(
      db
        .select({
          id: sql`${userId}`.as("id"),
          name: sql`${flow.data.name}`.as("name"),
          email: sql`${flow.data.recipientEmail}`.as("email"),
          normalizedEmail: sql`${flow.data.normalizedEmail}`.as("normalized_email"),
          image: sql`null`.as("image"),
          plan: sql`'free'`.as("plan"),
          paddleCustomerId: sql`null`.as("paddle_customer_id"),
          paddleSubscriptionId: sql`null`.as("paddle_subscription_id"),
          subscriptionStatus: sql`null`.as("subscription_status"),
          subscriptionUpdatedAt: sql`null`.as("subscription_updated_at"),
          role: sql`'user'`.as("role"),
          createdAt: sql`${nowSeconds}`.as("created_at"),
          updatedAt: sql`${nowSeconds}`.as("updated_at"),
        })
        .from(sql`(select 1)`)
        .where(flowExists),
    );
    const insertSession = db.insert(sessions).select(
      db
        .select({
          id: sql`${sessionId}`.as("id"),
          tokenHash: sql`${sessionTokenHash}`.as("token_hash"),
          previousTokenHash: sql`null`.as("previous_token_hash"),
          previousTokenExpiresAt: sql`null`.as("previous_token_expires_at"),
          rotationVersion: sql`0`.as("rotation_version"),
          userId: sql`${userId}`.as("user_id"),
          expiresAt: sql`${expiresAtSeconds}`.as("expires_at"),
          absoluteExpiresAt: sql`${absoluteExpiresAtSeconds}`.as("absolute_expires_at"),
          ipAddress: sql`${getClientIP()}`.as("ip_address"),
          userAgent: sql`${request.headers.get("User-Agent")?.slice(0, 500) ?? null}`.as(
            "user_agent",
          ),
          lastSeenAt: sql`null`.as("last_seen_at"),
          createdAt: sql`${nowSeconds}`.as("created_at"),
        })
        .from(sql`(select 1)`)
        .where(and(flowExists, sql`exists (select 1 from ${users} where ${users.id} = ${userId})`)),
    );
    const insertPasskeyGrant = db.insert(verifications).select(
      db
        .select({
          id: sql`${passkeyGrant.id}`.as("id"),
          type: sql`'passkey_register'`.as("type"),
          identifier: sql`${passkeyGrant.identifier}`.as("identifier"),
          value: sql`${passkeyGrant.secretHash}`.as("value"),
          data: sql`${passkeyGrant.data}`.as("data"),
          expiresAt: sql`${passkeyGrantExpiresAtSeconds}`.as("expires_at"),
          createdAt: sql`${nowSeconds}`.as("created_at"),
          updatedAt: sql`${nowSeconds}`.as("updated_at"),
        })
        .from(sql`(select 1)`)
        .where(
          and(
            flowExists,
            sql`exists (
              select 1 from ${sessions}
              where ${sessions.id} = ${sessionId}
                and ${sessions.userId} = ${userId}
            )`,
          ),
        ),
    );
    const [userInsertResult, sessionInsertResult, passkeyGrantInsertResult] = await db.batch([
      insertUser,
      insertSession,
      insertPasskeyGrant,
      consumeEmailAuthFlowStatement(db, flow, now),
      enforceSessionCapStatement(db, userId),
    ]);
    if (
      getRunChanges(userInsertResult) !== 1 ||
      getRunChanges(sessionInsertResult) !== 1 ||
      getRunChanges(passkeyGrantInsertResult) !== 1
    ) {
      throw createValidationError("Invalid or expired code.");
    }
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw createValidationError(
        "An account with this email already exists. Please sign in instead.",
      );
    }
    throw error;
  }

  await rememberDevice(db, env, userId, sessionId).catch(() => undefined);

  appendCookies([
    createCookieString("session", sessionToken, SESSION_EXPIRY_SECONDS, {
      appUrl: env.APP_URL,
      environment: env.ENVIRONMENT,
    }),
  ]);
  return {
    user: sanitizeUser(userRecord as typeof users.$inferSelect),
    passkeyRegistrationGrant: passkeyGrant.token,
  };
}

export async function resendOtpImpl({ data }: { data: v.InferOutput<typeof resendOtpSchema> }) {
  const env = await getEnv();
  const db = createDb(env.DB);
  await enforceIpRateLimit(env, "otp-resend");

  const flow = await loadEmailAuthFlow(db, "otp_signup", data.flowToken);
  if (!flow) throw createValidationError("Authentication flow expired. Please start again.");
  await enforceRateLimit(env, `otp-resend:${flow.data.normalizedEmail}`, true);
  const resent = await resendEmailAuthFlowCode(db, env, {
    type: "otp_signup",
    deliveryPurpose: "signup",
    flowToken: data.flowToken,
  });
  return { resent };
}
