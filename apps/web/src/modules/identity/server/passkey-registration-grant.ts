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
import { parseScopedFlowToken } from "./verification-attempts";

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
  const parsed = parseScopedFlowToken(token);
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
