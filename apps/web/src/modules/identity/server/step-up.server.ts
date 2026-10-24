/**
 * Server implementations for the step-up security-verification RPC surface.
 * Split from `step-up.functions.ts` so the RPC declaration file stays free of DB/Drizzle
 * imports and is safe to pull into client route graphs for its server-function
 * handles.
 */
import type { Database } from "@orbmeet/db";
import { verifications } from "@orbmeet/db/schema";
import { and, eq, gte, lte } from "drizzle-orm";
import type * as v from "valibot";

import { OTP_EXPIRY_MS } from "@/modules/identity/contract/auth/constants";
import {
  STEP_UP_ACTIONS,
  stepUpRequestSchema,
  type StepUpAction,
} from "@/modules/identity/contract/auth/schemas";
import { createValidationError } from "@/lib/app-errors";
import { generateOtp, hashOtp } from "@/modules/identity/server/crypto";
import { generateSessionToken, hashSessionToken } from "@/platform/crypto/tokens.server";
import {
  AUTOMATED_EMAIL_HEADERS,
  buildOtpEmail,
  isEmailConfigured,
  sendEmail,
} from "@/platform/email/delivery";
import { getRunChanges, withD1Retry } from "@/platform/database/db-utils";
import type { AuthFnContext } from "@/app/bootstrap/middleware";
import { enforceIpRateLimit, enforceRateLimit } from "@/platform/http/rate-limit.server";
import {
  hasVerificationAttemptsRemaining,
  reserveVerificationAttempt,
  verificationAttemptBudgetRemainingSql,
  type VerificationAttemptData,
} from "./verification-attempts";
import { timingSafeEqual } from "@orbmeet/primitives";

const STEP_UP_TTL_MS = OTP_EXPIRY_MS;
const STEP_UP_DELIVERY_COOLDOWN_MS = 60_000;

interface StepUpFlowData extends VerificationAttemptData {
  version: 1;
  secretHash: string;
  userId: string;
  authSessionId: string;
  action: StepUpAction;
  targetId: string | null;
}

export interface StepUpCredential {
  flowToken: string;
  otp: string;
}

function stepUpIdentifier(flowId: string): string {
  return `step-up:${flowId}`;
}

export function parseStepUpFlowToken(flowToken: string): { id: string; secret: string } | null {
  const separator = flowToken.indexOf(".");
  if (separator < 1 || separator !== flowToken.lastIndexOf(".")) return null;
  const id = flowToken.slice(0, separator);
  const secret = flowToken.slice(separator + 1);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) ||
    !/^[a-f0-9]{64}$/i.test(secret)
  ) {
    return null;
  }
  return { id, secret };
}

function parseStepUpData(raw: string | null): StepUpFlowData | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<StepUpFlowData>;
    if (
      value.version !== 1 ||
      typeof value.secretHash !== "string" ||
      !/^[a-f0-9]{64}$/i.test(value.secretHash) ||
      typeof value.userId !== "string" ||
      typeof value.authSessionId !== "string" ||
      typeof value.action !== "string" ||
      !STEP_UP_ACTIONS.includes(value.action) ||
      !(typeof value.targetId === "string" || value.targetId === null) ||
      !hasVerificationAttemptsRemaining(value)
    ) {
      return null;
    }
    return value as StepUpFlowData;
  } catch {
    return null;
  }
}

async function claimStepUpDelivery(
  db: Database,
  userId: string,
): Promise<{ identifier: string; claimId: string } | null> {
  const now = new Date();
  const identifier = `step-up:${userId}`;
  const claimId = crypto.randomUUID();
  const result = await db
      .insert(verifications)
      .values({
        id: crypto.randomUUID(),
        type: "otp_delivery",
        identifier,
        value: claimId,
        data: null,
        expiresAt: new Date(now.getTime() + STEP_UP_DELIVERY_COOLDOWN_MS),
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [verifications.type, verifications.identifier],
        set: {
          value: claimId,
          expiresAt: new Date(now.getTime() + STEP_UP_DELIVERY_COOLDOWN_MS),
          updatedAt: now,
        },
        setWhere: lte(verifications.expiresAt, now),
      })
    .run();
  return getRunChanges(result) === 1 ? { identifier, claimId } : null;
}

async function releaseStepUpDelivery(
  db: Database,
  lease: { identifier: string; claimId: string },
): Promise<void> {
  await withD1Retry(
    () =>
      db
        .delete(verifications)
        .where(
          and(
            eq(verifications.type, "otp_delivery"),
            eq(verifications.identifier, lease.identifier),
            eq(verifications.value, lease.claimId),
          ),
        ),
    { idempotent: true },
  ).catch(() => undefined);
}

export async function requestStepUpImpl({
  data,
  context: { user, authSessionId, env, db },
}: {
  data: v.InferOutput<typeof stepUpRequestSchema>;
  context: AuthFnContext;
}): Promise<{ flowToken: string }> {
  const requiresTarget = data.action === "passkey_delete" || data.action === "session_revoke";
  if (requiresTarget !== Boolean(data.targetId)) {
    throw createValidationError("Invalid security action.");
  }
  await enforceIpRateLimit(env, "step-up-request");
  await enforceRateLimit(env, `step-up-request:${user.id}`, true);
  if (!isEmailConfigured(env.EMAIL)) {
    throw createValidationError("Email authentication is not configured.");
  }

  const lease = await claimStepUpDelivery(db, user.id);
  if (!lease) {
    throw createValidationError("Please wait a minute before requesting another code.");
  }

  const flowId = crypto.randomUUID();
  const secret = generateSessionToken();
  const secretHash = await hashSessionToken(secret);
  const otp = generateOtp();
  const value = await hashOtp(otp, `otp_step_up:${flowId}`, env.AUTH_SECRET);
  const now = new Date();
  const flowData: StepUpFlowData = {
    version: 1,
    secretHash,
    userId: user.id,
    authSessionId,
    action: data.action,
    targetId: data.targetId ?? null,
    failedAttempts: 0,
  };

  try {
    await db.insert(verifications).values({
        id: flowId,
        type: "otp_step_up",
        identifier: stepUpIdentifier(flowId),
        value,
        data: JSON.stringify(flowData),
        expiresAt: new Date(now.getTime() + STEP_UP_TTL_MS),
        updatedAt: now,
    });
    const { subject, html, text } = buildOtpEmail(
      otp,
      data.action === "account_delete" ? "delete-account" : "security-action",
    );
    const sent = await sendEmail(env.EMAIL, {
      to: user.email,
      subject,
      html,
      text,
      from: env.EMAIL_FROM_ADDRESS,
      headers: AUTOMATED_EMAIL_HEADERS,
    });
    if (!sent) throw createValidationError("Failed to send verification email.");
  } catch (error) {
    await withD1Retry(() => db.delete(verifications).where(eq(verifications.id, flowId)), {
      idempotent: true,
    }).catch(() => undefined);
    await releaseStepUpDelivery(db, lease);
    throw error;
  }

  return { flowToken: `${flowId}.${secret}` };
}

export async function consumeStepUpCredential(
  db: Database,
  env: Env,
  input: {
    credential: StepUpCredential;
    userId: string;
    authSessionId: string;
    action: StepUpAction;
    targetId?: string;
  },
): Promise<{ flowId: string; secretHash: string }> {
  const prepared = await prepareStepUpCredentialConsumption(db, env, input);
  const result = await withD1Retry(
    () =>
      db
        .delete(verifications)
        .where(
          and(
            eq(verifications.id, prepared.verificationId),
            eq(verifications.value, prepared.verificationValue),
            verificationAttemptBudgetRemainingSql(),
          ),
        )
        .run(),
    { idempotent: true },
  );
  if (getRunChanges(result) !== 1) {
    throw createValidationError("Security verification expired.");
  }
  return { flowId: prepared.flowId, secretHash: prepared.secretHash };
}

export async function prepareStepUpCredentialConsumption(
  db: Database,
  env: Env,
  input: {
    credential: StepUpCredential;
    userId: string;
    authSessionId: string;
    action: StepUpAction;
    targetId?: string;
  },
): Promise<{
  flowId: string;
  secretHash: string;
  verificationId: string;
  verificationValue: string;
}> {
  const token = parseStepUpFlowToken(input.credential.flowToken);
  if (!token) throw createValidationError("Security verification expired.");

  const row = await db.query.verifications.findFirst({
    where: {
      RAW: (verification) =>
        and(
          eq(verification.id, token.id),
          eq(verification.type, "otp_step_up"),
          eq(verification.identifier, stepUpIdentifier(token.id)),
          gte(verification.expiresAt, new Date()),
        )!,
    },
  });
  const data = parseStepUpData(row?.data ?? null);
  if (
    !row ||
    !data ||
    data.userId !== input.userId ||
    data.authSessionId !== input.authSessionId ||
    data.action !== input.action ||
    data.targetId !== (input.targetId ?? null)
  ) {
    throw createValidationError("Security verification expired.");
  }

  const providedSecretHash = await hashSessionToken(token.secret);
  if (!await timingSafeEqual(data.secretHash, providedSecretHash)) {
    throw createValidationError("Invalid or expired security code.");
  }
  // Reserve the attempt before comparing, exactly like the email flows: the
  // conditional UPDATE both counts the attempt and proves the budget is not
  // exhausted, so parallel guesses can never compare more codes than the
  // budget allows and a comparison can never outlive the fifth failure.
  const reserved = await reserveVerificationAttempt(db, row);
  if (!reserved) {
    throw createValidationError("Invalid or expired security code.");
  }
  const providedCodeHash = await hashOtp(
    input.credential.otp,
    `otp_step_up:${token.id}`,
    env.AUTH_SECRET,
  );
  if (!await timingSafeEqual(row.value, providedCodeHash)) {
    // Already counted by the reservation above.
    throw createValidationError("Invalid or expired security code.");
  }

  return {
    flowId: token.id,
    secretHash: data.secretHash,
    verificationId: row.id,
    verificationValue: row.value,
  };
}

export async function authorizeSensitiveAction(
  db: Database,
  env: Env,
  input: {
    credential?: StepUpCredential;
    userId: string;
    authSessionId: string;
    action: StepUpAction;
    targetId?: string;
  },
): Promise<void> {
  if (!input.credential) {
    throw createValidationError("Security verification required.");
  }
  await consumeStepUpCredential(db, env, {
    credential: input.credential,
    userId: input.userId,
    authSessionId: input.authSessionId,
    action: input.action,
    targetId: input.targetId,
  });
}
