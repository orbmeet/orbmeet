import "@tanstack/react-start/server-only";
import { timingSafeEqual } from "@orbmeet/primitives";

import type { Database } from "@orbmeet/db";
import { OTP_EXPIRY_MS } from "@/modules/identity/contract/auth/constants";
import { createValidationError } from "@/lib/app-errors";
import { and, eq, gte } from "drizzle-orm";
import {
  generateSessionToken,
  hashSessionToken,
} from "@/platform/crypto/tokens.server";

interface PasskeyRegistrationGrantData {
  version: 1;
  userId: string;
  authSessionId: string;
}

export interface PreparedPasskeyRegistrationGrant {
  id: string;
  token: string;
  secretHash: string;
  identifier: string;
  data: string;
  expiresAt: Date;
}

function parseGrantToken(token: string): { id: string; secret: string } | null {
  const separator = token.indexOf(".");
  if (separator < 1 || separator !== token.lastIndexOf(".")) return null;
  const id = token.slice(0, separator);
  const secret = token.slice(separator + 1);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) ||
    !/^[a-f0-9]{64}$/i.test(secret)
  ) {
    return null;
  }
  return { id, secret };
}

function parseGrantData(raw: string | null): PasskeyRegistrationGrantData | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<PasskeyRegistrationGrantData>;
    if (
      value.version !== 1 ||
      typeof value.userId !== "string" ||
      typeof value.authSessionId !== "string"
    ) {
      return null;
    }
    return value as PasskeyRegistrationGrantData;
  } catch {
    return null;
  }
}

export async function preparePasskeyRegistrationGrant(
  userId: string,
  authSessionId: string,
  now: Date,
): Promise<PreparedPasskeyRegistrationGrant> {
  const id = crypto.randomUUID();
  const secret = generateSessionToken();
  const secretHash = await hashSessionToken(secret);
  return {
    id,
    token: `${id}.${secret}`,
    secretHash,
    identifier: `passkey-signup-grant:${id}`,
    data: JSON.stringify({ version: 1, userId, authSessionId }),
    expiresAt: new Date(now.getTime() + OTP_EXPIRY_MS),
  };
}

export async function preparePasskeyRegistrationGrantConsumption(
  db: Database,
  token: string,
  input: { userId: string; authSessionId: string },
): Promise<{ id: string; value: string }> {
  const parsed = parseGrantToken(token);
  if (!parsed) throw createValidationError("Passkey registration authorization expired.");

  const row = await db.query.verifications.findFirst({
    where: {
      RAW: (verification) =>
        and(
          eq(verification.id, parsed.id),
          eq(verification.type, "passkey_register"),
          eq(verification.identifier, `passkey-signup-grant:${parsed.id}`),
          gte(verification.expiresAt, new Date()),
        )!,
    },
  });
  const data = parseGrantData(row?.data ?? null);
  const providedSecretHash = await hashSessionToken(parsed.secret);
  if (
    !row ||
    !data ||
    data.userId !== input.userId ||
    data.authSessionId !== input.authSessionId ||
    !await timingSafeEqual(row.value, providedSecretHash)
  ) {
    throw createValidationError("Passkey registration authorization expired.");
  }

  return { id: row.id, value: row.value };
}
