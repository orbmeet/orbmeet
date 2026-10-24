import "@tanstack/react-start/server-only";
import { timingSafeEqual } from "@orbmeet/primitives";

import type { Database } from "@orbmeet/db";
import { verifications } from "@orbmeet/db/schema";
import { OTP_EXPIRY_MS } from "@/modules/identity/contract/auth/constants";
import { createValidationError } from "@/lib/app-errors";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import { readCloudflareContext } from "@/platform/runtime/cloudflare-context";
import { logError } from "@/lib/logger";
import {
  AUTOMATED_EMAIL_HEADERS,
  buildOtpEmail,
  isEmailConfigured,
  sendEmail,
} from "@/platform/email/delivery";
import { generateOtp, hashOtp } from "@/modules/identity/server/crypto";
import {
  generateSessionToken,
  hashSessionToken,
  hmacSha256Hex,
} from "@/platform/crypto/tokens.server";
import { networkOf } from "@/platform/http/client-ip";
import { getClientIP } from "@/platform/http/client-ip.server";
import { getRunChanges, withD1Retry } from "@/platform/database/db-utils";
import {
  hasVerificationAttemptsRemaining,
  reserveVerificationAttempt,
  verificationAttemptBudgetRemainingSql,
  type VerificationAttemptData,
} from "./verification-attempts";

const EMAIL_DELIVERY_COOLDOWN_MS = 60_000;

// Codes for an address are budgeted per requester, the network asking: the
// 60-second lease throttles rate, and this caps the codes one requester can
// have sent to one address per UTC day, well above what a real person needs.
// Keyed on the address alone, either limit was a lockout anyone who knew the
// address could impose — a request a minute held the lease, and twenty used
// the day's budget. Per requester, someone else's requests spend only their
// own budget; mail to an address grows only with the networks a sender has.
// Passkey and Google sign-in are unaffected, and the day-bucketed key lets the
// window reset without any timestamp arithmetic in SQL.
export const EMAIL_DELIVERY_DAILY_CAP = 5;
const DELIVERY_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The requester of a delivery, as an opaque key: their network, keyed by a
 * server secret so the table holds nothing that maps back to an address.
 */
function deliveryRequester(env: Env): Promise<string> {
  return hmacSha256Hex(env.AUTH_SECRET, `otp-delivery-requester:${networkOf(getClientIP()) ?? "unknown"}`);
}

async function withinDailyDeliveryCap(
  db: Database,
  purpose: string,
  subject: string,
  requester: string,
): Promise<boolean> {
  const now = new Date();
  const dayBucket = Math.floor(now.getTime() / DELIVERY_DAY_MS);
  const identifier = `daily:${dayBucket}:${purpose}:${subject}:${requester}`;
  // Kept a full day past the bucket so the expiry sweep reclaims it well after
  // the window it counts has closed.
  const expiresAt = new Date((dayBucket + 2) * DELIVERY_DAY_MS);
  const [row] = await db
    .insert(verifications)
    .values({
      id: crypto.randomUUID(),
      type: "otp_delivery",
      identifier,
      value: "1",
      data: null,
      expiresAt,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [verifications.type, verifications.identifier],
      set: {
        value: sql`cast(cast(${verifications.value} as integer) + 1 as text)`,
        updatedAt: now,
      },
    })
    .returning({ value: verifications.value });
  const count = row ? Number.parseInt(row.value, 10) : 1;
  // Never lock a real person out over a counter that cannot be read.
  if (!Number.isFinite(count)) return true;
  return count <= EMAIL_DELIVERY_DAILY_CAP;
}

export type EmailAuthFlowType = "otp_signup" | "otp_login";

export interface EmailAuthFlowData extends VerificationAttemptData {
  version: 1;
  secretHash: string;
  normalizedEmail: string;
  recipientEmail: string | null;
  userId: string | null;
  name?: string;
}

function flowIdentifier(flowId: string): string {
  return `auth-flow:${flowId}`;
}

function codeScope(type: EmailAuthFlowType | "otp_step_up", flowId: string): string {
  return `${type}:${flowId}`;
}

function parseFlowToken(flowToken: string): { id: string; secret: string } | null {
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

function parseFlowData(raw: string | null): EmailAuthFlowData | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<EmailAuthFlowData>;
    if (
      parsed.version !== 1 ||
      typeof parsed.secretHash !== "string" ||
      !/^[a-f0-9]{64}$/i.test(parsed.secretHash) ||
      typeof parsed.normalizedEmail !== "string" ||
      !(typeof parsed.recipientEmail === "string" || parsed.recipientEmail === null) ||
      !(typeof parsed.userId === "string" || parsed.userId === null) ||
      !(parsed.name === undefined || typeof parsed.name === "string") ||
      !hasVerificationAttemptsRemaining(parsed)
    ) {
      return null;
    }
    return parsed as EmailAuthFlowData;
  } catch {
    return null;
  }
}

async function claimDeliveryLease(
  db: Database,
  env: Env,
  purpose: string,
  subject: string,
): Promise<{ identifier: string; claimId: string } | null> {
  const now = new Date();
  const requester = await deliveryRequester(env);
  const identifier = `${purpose}:${subject}:${requester}`;
  const claimId = crypto.randomUUID();
  const result = await db
    .insert(verifications)
    .values({
      id: crypto.randomUUID(),
      type: "otp_delivery",
      identifier,
      value: claimId,
      data: null,
      expiresAt: new Date(now.getTime() + EMAIL_DELIVERY_COOLDOWN_MS),
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [verifications.type, verifications.identifier],
      set: {
        value: claimId,
        expiresAt: new Date(now.getTime() + EMAIL_DELIVERY_COOLDOWN_MS),
        updatedAt: now,
      },
      setWhere: lte(verifications.expiresAt, now),
    })
    .run();
  if (getRunChanges(result) !== 1) return null;
  const lease = { identifier, claimId };
  // The per-minute lease is held; now enforce the per-day volume cap. If the
  // requester is over its daily budget for the address, release the lease so
  // the throttle state reflects the real reason delivery was refused, and
  // report no lease.
  if (!(await withinDailyDeliveryCap(db, purpose, subject, requester))) {
    await releaseDeliveryLease(db, lease);
    return null;
  }
  return lease;
}

async function releaseDeliveryLease(
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

export async function createEmailAuthFlow(
  db: Database,
  env: Env,
  input: {
    type: EmailAuthFlowType;
    deliveryPurpose: "signup" | "login";
    deliverySubject: string;
    data: Omit<EmailAuthFlowData, "version" | "secretHash" | "failedAttempts">;
  },
): Promise<{ flowId: string; flowToken: string }> {
  const lease = await claimDeliveryLease(db, env, input.deliveryPurpose, input.deliverySubject);
  if (!lease) {
    throw createValidationError(
      "Please wait before requesting another code, or sign in with a passkey or Google.",
    );
  }

  const flowId = crypto.randomUUID();
  const flowSecret = generateSessionToken();
  const secretHash = await hashSessionToken(flowSecret);
  const code = generateOtp();
  const codeHash = await hashOtp(code, codeScope(input.type, flowId), env.AUTH_SECRET);
  const now = new Date();
  const flowData: EmailAuthFlowData = {
    version: 1,
    secretHash,
    failedAttempts: 0,
    ...input.data,
  };

  try {
    await db.insert(verifications).values({
      id: flowId,
      type: input.type,
      identifier: flowIdentifier(flowId),
      value: codeHash,
      data: JSON.stringify(flowData),
      expiresAt: new Date(now.getTime() + OTP_EXPIRY_MS),
      updatedAt: now,
    });

    // Provider latency must not disclose whether this is a real account, so
    // delivery is deferred past the response wherever a Cloudflare execution
    // context exists. The durable flow is already written; a delivery failure
    // releases the cooldown so the caller can resend through the same opaque
    // flow. Without a context (tests, dev) it runs inline.
    const deliver = async () => {
      if (!flowData.recipientEmail) return;
      if (!isEmailConfigured(env.EMAIL)) {
        throw new Error("Email authentication is not configured");
      }
      const { subject, html, text } = buildOtpEmail(code, input.deliveryPurpose);
      const sent = await sendEmail(env.EMAIL, {
        to: flowData.recipientEmail,
        subject,
        html,
        text,
        from: env.EMAIL_FROM_ADDRESS,
        headers: AUTOMATED_EMAIL_HEADERS,
      });
      if (!sent) {
        throw createValidationError("Failed to send verification email. Please try again.");
      }
    };
    const ctx = readCloudflareContext()?.ctx;
    if (ctx) {
      ctx.waitUntil(
        deliver().catch(async (error) => {
          logError("[auth] Verification delivery failed", error);
          await releaseDeliveryLease(db, lease);
        }),
      );
    } else {
      await deliver();
    }
  } catch (error) {
    await withD1Retry(() => db.delete(verifications).where(eq(verifications.id, flowId)), {
      idempotent: true,
    }).catch(() => undefined);
    await releaseDeliveryLease(db, lease);
    throw error;
  }

  return { flowId, flowToken: `${flowId}.${flowSecret}` };
}

export async function loadEmailAuthFlow(
  db: Database,
  type: EmailAuthFlowType,
  flowToken: string,
): Promise<{
  id: string;
  value: string;
  expiresAt: Date;
  data: EmailAuthFlowData;
} | null> {
  const token = parseFlowToken(flowToken);
  if (!token) return null;
  const row = await db.query.verifications.findFirst({
    where: {
      RAW: (verification) =>
        and(
          eq(verification.id, token.id),
          eq(verification.type, type),
          eq(verification.identifier, flowIdentifier(token.id)),
          gte(verification.expiresAt, new Date()),
        )!,
    },
  });
  if (!row) return null;
  const data = parseFlowData(row.data);
  if (!data) return null;
  const providedSecretHash = await hashSessionToken(token.secret);
  if (!await timingSafeEqual(data.secretHash, providedSecretHash)) return null;
  return {
    id: row.id,
    value: row.value,
    expiresAt: row.expiresAt,
    data,
  };
}

/**
 * Reserve one attempt, then — only if the reservation won — compare the code.
 *
 * The reservation is the security boundary: a request that could not reserve
 * (budget exhausted, flow expired or rotated) never gets to compare, and a
 * request that did reserve has had its attempt counted no matter what the
 * comparison returns. This is what keeps total comparisons per code at or
 * below MAX_FAILED_VERIFICATION_ATTEMPTS even under parallel guesses.
 */
export async function verifyEmailAuthFlowCode(
  db: Database,
  env: Env,
  type: EmailAuthFlowType,
  flow: { id: string; value: string },
  code: string,
): Promise<void> {
  const reserved = await reserveVerificationAttempt(db, flow);
  if (!reserved) {
    throw createValidationError("Invalid or expired code.");
  }
  const codeHash = await hashOtp(code, codeScope(type, flow.id), env.AUTH_SECRET);
  if (!await timingSafeEqual(flow.value, codeHash)) {
    // The attempt was already counted by the reservation above; recording it
    // again here would double-charge one guess.
    throw createValidationError("Invalid or expired code.");
  }
}

/**
 * True while the verified flow is still the stored one, unexpired and within
 * its attempt budget: the gate the write a code unlocks (a session, an
 * account) fences on, in the same batch as {@link consumeEmailAuthFlowStatement}.
 */
export function emailAuthFlowLiveSql(flow: { id: string; value: string }, now: Date) {
  return sql`exists (
    select 1 from ${verifications}
    where ${verifications.id} = ${flow.id}
      and ${verifications.value} = ${flow.value}
      and ${verifications.expiresAt} >= ${Math.floor(now.getTime() / 1000)}
      and ${verificationAttemptBudgetRemainingSql()}
  )`;
}

/** Spend the verified flow: the statement a consuming batch ends the flow with. */
export function consumeEmailAuthFlowStatement(db: Database, flow: { id: string; value: string }, now: Date) {
  return db
    .delete(verifications)
    .where(
      and(
        eq(verifications.id, flow.id),
        eq(verifications.value, flow.value),
        gte(verifications.expiresAt, now),
        verificationAttemptBudgetRemainingSql(),
      ),
    );
}

export async function resendEmailAuthFlowCode(
  db: Database,
  env: Env,
  input: {
    type: EmailAuthFlowType;
    deliveryPurpose: "signup" | "login";
    flowToken: string;
  },
): Promise<boolean> {
  const flow = await loadEmailAuthFlow(db, input.type, input.flowToken);
  if (!flow) throw createValidationError("Authentication flow expired. Please start again.");

  const lease = await claimDeliveryLease(db, env, input.deliveryPurpose, flow.data.normalizedEmail);
  if (!lease) return false;
  if (flow.data.recipientEmail && !isEmailConfigured(env.EMAIL)) {
    await releaseDeliveryLease(db, lease);
    throw new Error("Email authentication is not configured");
  }

  const code = generateOtp();
  const codeHash = await hashOtp(code, codeScope(input.type, flow.id), env.AUTH_SECRET);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + OTP_EXPIRY_MS);
  const updated = await db
    .update(verifications)
    .set({
      value: codeHash,
      // The flow metadata, including failedAttempts, is unchanged by a
      // resend. Leaving the JSON column untouched avoids overwriting an
      // attempt that commits between the initial load and this update.
      expiresAt,
      updatedAt: now,
    })
    .where(
      and(
        eq(verifications.id, flow.id),
        eq(verifications.value, flow.value),
        gte(verifications.expiresAt, now),
      ),
    )
    .run();
  if (getRunChanges(updated) !== 1) {
    await releaseDeliveryLease(db, lease);
    throw createValidationError("Authentication flow expired. Please start again.");
  }

  // Deferred for the same reason as the initial send: the caller must not be
  // able to time the provider and learn whether the address exists. Failure
  // restores the previous code and releases the cooldown inside `deliver`.
  const deliver = async () => {
    if (!flow.data.recipientEmail) return;
    const { subject, html, text } = buildOtpEmail(code, input.deliveryPurpose);
    const sent = await sendEmail(env.EMAIL, {
      to: flow.data.recipientEmail,
      subject,
      html,
      text,
      from: env.EMAIL_FROM_ADDRESS,
      headers: AUTOMATED_EMAIL_HEADERS,
    });
    if (!sent) {
      await withD1Retry(
        () =>
          db
            .update(verifications)
            .set({
              value: flow.value,
              expiresAt: flow.expiresAt,
              updatedAt: new Date(),
            })
            .where(and(eq(verifications.id, flow.id), eq(verifications.value, codeHash))),
        { idempotent: true },
      );
      await releaseDeliveryLease(db, lease);
      throw createValidationError("Failed to send verification email. Please try again.");
    }
  };
  const ctx = readCloudflareContext()?.ctx;
  if (ctx) {
    ctx.waitUntil(
      deliver().catch((error) => {
        logError("[auth] Verification redelivery failed", error);
      }),
    );
  } else {
    await deliver();
  }
  return true;
}
