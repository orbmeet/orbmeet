import { getRunChanges } from "@/platform/database/db-utils";
import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@/test/db";
import { verifications } from "@orbmeet/db/schema";
import { hashOtp } from "@/modules/identity/server/crypto";
import { hashSessionToken } from "@/platform/crypto/tokens.server";
import {
  consumeEmailAuthFlowStatement,
  loadEmailAuthFlow,
  verifyEmailAuthFlowCode,
} from "./email-flow";

let db: TestDb;

/** Whether spending the flow, as sign-in and sign-up do, deleted it. */
async function consumeFlow(flow: { id: string; value: string }) {
  return getRunChanges(await consumeEmailAuthFlowStatement(db, flow, new Date()).run()) === 1;
}
const env = { AUTH_SECRET: "test-auth-secret-with-at-least-32-characters" } as Env;

beforeEach(async () => {
  db = await createTestDb();
});

async function insertFlow(input: {
  id?: string;
  secret?: string;
  code?: string;
  email?: string;
}) {
  const id = input.id ?? crypto.randomUUID();
  const secret = input.secret ?? "a".repeat(64);
  const code = input.code ?? "123456";
  const normalizedEmail = input.email ?? "user@example.com";
  const secretHash = await hashSessionToken(secret);
  const value = await hashOtp(code, `otp_login:${id}`, env.AUTH_SECRET);
  await db.insert(verifications).values({
    id,
    type: "otp_login",
    identifier: `auth-flow:${id}`,
    value,
    data: JSON.stringify({
      version: 1,
      secretHash,
      normalizedEmail,
      recipientEmail: normalizedEmail,
      userId: "user_1",
      failedAttempts: 0,
    }),
    expiresAt: new Date(Date.now() + 600_000),
    updatedAt: new Date(),
  });
  return { id, secret, code, value, flowToken: `${id}.${secret}` };
}

describe("browser-bound email authentication flows", () => {
  it("loads and verifies a flow only with its secret and code", async () => {
    const created = await insertFlow({});
    const flow = await loadEmailAuthFlow(db, "otp_login", created.flowToken);
    expect(flow?.id).toBe(created.id);
    await expect(
      verifyEmailAuthFlowCode(db, env, "otp_login", flow!, created.code),
    ).resolves.toBeUndefined();

    await expect(
      verifyEmailAuthFlowCode(db, env, "otp_login", flow!, "987654"),
    ).rejects.toThrow("Invalid or expired code");
    await expect(
      loadEmailAuthFlow(db, "otp_login", `${created.id}.${"b".repeat(64)}`),
    ).resolves.toBeNull();
  });

  it("expires a flow after five failed code attempts", async () => {
    const created = await insertFlow({});
    for (let attempt = 0; attempt < 5; attempt++) {
      const flow = await loadEmailAuthFlow(db, "otp_login", created.flowToken);
      expect(flow).not.toBeNull();
      await expect(
        verifyEmailAuthFlowCode(db, env, "otp_login", flow!, "987654"),
      ).rejects.toThrow("Invalid or expired code");
    }

    await expect(loadEmailAuthFlow(db, "otp_login", created.flowToken))
      .resolves.toBeNull();
  });

  it("allows concurrent flows for the same account", async () => {
    const first = await insertFlow({ secret: "a".repeat(64), code: "123456" });
    const second = await insertFlow({ secret: "b".repeat(64), code: "987654" });

    await expect(loadEmailAuthFlow(db, "otp_login", first.flowToken)).resolves.toBeTruthy();
    await expect(loadEmailAuthFlow(db, "otp_login", second.flowToken)).resolves.toBeTruthy();
  });

  it("consumes a flow exactly once", async () => {
    const created = await insertFlow({});
    const flow = (await loadEmailAuthFlow(db, "otp_login", created.flowToken))!;
    await expect(consumeFlow(flow)).resolves.toBe(true);
    await expect(consumeFlow(flow)).resolves.toBe(false);
  });
});
