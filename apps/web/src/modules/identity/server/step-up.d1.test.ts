import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@/test/db";
import { verifications } from "@orbmeet/db/schema";
import { hashOtp } from "@/modules/identity/server/crypto";
import { generateSessionToken, hashSessionToken } from "@/platform/crypto/tokens.server";
import { consumeStepUpCredential } from "./step-up.server";

let db: TestDb;
const env = { AUTH_SECRET: "test-auth-secret-with-at-least-32-characters" } as Env;

beforeEach(async () => {
  db = await createTestDb();
});

async function insertStepUp(input?: {
  action?: "passkey_register" | "passkey_delete";
  targetId?: string | null;
}) {
  const id = crypto.randomUUID();
  const secret = generateSessionToken();
  const otp = "123456";
  const secretHash = await hashSessionToken(secret);
  const value = await hashOtp(otp, `otp_step_up:${id}`, env.AUTH_SECRET);
  const now = new Date();
  await db.insert(verifications).values({
    id,
    type: "otp_step_up",
    identifier: `step-up:${id}`,
    value,
    data: JSON.stringify({
      version: 1,
      secretHash,
      userId: "user_1",
      authSessionId: "session_1",
      action: input?.action ?? "passkey_register",
      targetId: input?.targetId ?? null,
      failedAttempts: 0,
    }),
    expiresAt: new Date(now.getTime() + 600_000),
    createdAt: now,
    updatedAt: now,
  });
  return { flowToken: `${id}.${secret}`, otp };
}

describe("action-specific step-up credentials", () => {
  it("consumes a credential bound to its user, session, action, and target", async () => {
    const credential = await insertStepUp({
      action: "passkey_delete",
      targetId: "passkey_1",
    });
    await expect(consumeStepUpCredential(db, env, {
      credential,
      userId: "user_1",
      authSessionId: "session_1",
      action: "passkey_delete",
      targetId: "passkey_1",
    })).resolves.toMatchObject({ flowId: expect.any(String) });

    await expect(consumeStepUpCredential(db, env, {
      credential,
      userId: "user_1",
      authSessionId: "session_1",
      action: "passkey_delete",
      targetId: "passkey_1",
    })).rejects.toThrow("Security verification expired");
  });

  it("rejects reuse for another action, target, or session", async () => {
    const credential = await insertStepUp({
      action: "passkey_delete",
      targetId: "passkey_1",
    });
    await expect(consumeStepUpCredential(db, env, {
      credential,
      userId: "user_1",
      authSessionId: "session_2",
      action: "passkey_delete",
      targetId: "passkey_1",
    })).rejects.toThrow("Security verification expired");
    await expect(consumeStepUpCredential(db, env, {
      credential,
      userId: "user_1",
      authSessionId: "session_1",
      action: "passkey_delete",
      targetId: "passkey_2",
    })).rejects.toThrow("Security verification expired");
    await expect(consumeStepUpCredential(db, env, {
      credential,
      userId: "user_1",
      authSessionId: "session_1",
      action: "passkey_register",
    })).rejects.toThrow("Security verification expired");
  });

  it("rejects the correct code without the flow secret", async () => {
    const credential = await insertStepUp();
    await expect(consumeStepUpCredential(db, env, {
      credential: {
        ...credential,
        flowToken: `${credential.flowToken.slice(0, 36)}.${"f".repeat(64)}`,
      },
      userId: "user_1",
      authSessionId: "session_1",
      action: "passkey_register",
    })).rejects.toThrow("Invalid or expired security code");
  });

  it("expires a credential after five failed code attempts", async () => {
    const credential = await insertStepUp();
    const input = {
      credential: { ...credential, otp: "987654" },
      userId: "user_1",
      authSessionId: "session_1",
      action: "passkey_register" as const,
    };

    for (let attempt = 0; attempt < 5; attempt++) {
      await expect(consumeStepUpCredential(db, env, input))
        .rejects.toThrow("Invalid or expired security code");
    }
    await expect(consumeStepUpCredential(db, env, {
      ...input,
      credential,
    })).rejects.toThrow("Security verification expired");
  });

  it("accepts a correct code on the fifth and final attempt of the budget", async () => {
    const credential = await insertStepUp();

    // Each wrong guess now reserves an attempt atomically before comparing.
    for (let attempt = 0; attempt < 4; attempt++) {
      await expect(consumeStepUpCredential(db, env, {
        credential: { ...credential, otp: "987654" },
        userId: "user_1",
        authSessionId: "session_1",
        action: "passkey_register",
      })).rejects.toThrow("Invalid or expired security code");
    }

    await expect(consumeStepUpCredential(db, env, {
      credential,
      userId: "user_1",
      authSessionId: "session_1",
      action: "passkey_register",
    })).resolves.toMatchObject({ flowId: expect.any(String) });
  });
});
