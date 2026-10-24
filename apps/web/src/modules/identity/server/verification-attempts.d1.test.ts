import { getRunChanges } from "@/platform/database/db-utils";
import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@/test/db";
import { verifications } from "@orbmeet/db/schema";
import { eq } from "drizzle-orm";
import { hashOtp } from "@/modules/identity/server/crypto";
import { hashSessionToken } from "@/platform/crypto/tokens.server";
import {
  consumeEmailAuthFlowStatement,
  loadEmailAuthFlow,
  verifyEmailAuthFlowCode,
} from "./email-flow";
import {
  MAX_FAILED_VERIFICATION_ATTEMPTS,
  reserveVerificationAttempt,
} from "./verification-attempts";

let db: TestDb;

/** Whether spending the flow, as sign-in and sign-up do, deleted it. */
async function consumeFlow(flow: { id: string; value: string }) {
  return getRunChanges(await consumeEmailAuthFlowStatement(db, flow, new Date()).run()) === 1;
}
const env = { AUTH_SECRET: "test-auth-secret-with-at-least-32-characters" } as Env;

beforeEach(async () => {
  db = await createTestDb();
});

async function insertFlow(input?: { code?: string }) {
  const id = crypto.randomUUID();
  const secret = "a".repeat(64);
  const code = input?.code ?? "123456";
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
      normalizedEmail: "user@example.com",
      recipientEmail: "user@example.com",
      userId: "user_1",
      failedAttempts: 0,
    }),
    expiresAt: new Date(Date.now() + 600_000),
    updatedAt: new Date(),
  });
  return { id, value, code, flowToken: `${id}.${secret}` };
}

async function failedAttempts(id: string): Promise<number> {
  const row = await db.query.verifications.findFirst({
    where: { id },
    columns: { data: true },
  });
  return row?.data
    ? (JSON.parse(row.data) as { failedAttempts?: number }).failedAttempts ?? 0
    : -1;
}

describe("atomic verification attempt reservation", () => {
  it("allows exactly the budgeted number of reservations, then none", async () => {
    const flow = await insertFlow();

    for (let attempt = 1; attempt <= MAX_FAILED_VERIFICATION_ATTEMPTS; attempt++) {
      await expect(
        reserveVerificationAttempt(db, { id: flow.id, value: flow.value }),
      ).resolves.toBe(true);
      expect(await failedAttempts(flow.id)).toBe(attempt);
    }

    // The 6th reservation finds failedAttempts at the cap and changes nothing.
    await expect(
      reserveVerificationAttempt(db, { id: flow.id, value: flow.value }),
    ).resolves.toBe(false);
    expect(await failedAttempts(flow.id)).toBe(MAX_FAILED_VERIFICATION_ATTEMPTS);
  });

  it("refuses to reserve against an unknown or expired verification", async () => {
    const flow = await insertFlow();

    await expect(
      reserveVerificationAttempt(db, { id: flow.id, value: "b".repeat(64) }),
    ).resolves.toBe(false);

    await db
      .update(verifications)
      .set({
        // The table's CHECK requires expires_at to stay after created_at, so
        // both move together to build an expired row.
        expiresAt: new Date(Date.now() - 1000),
        createdAt: new Date(Date.now() - 60_000),
      })
      .where(eq(verifications.id, flow.id));
    await expect(
      reserveVerificationAttempt(db, { id: flow.id, value: flow.value }),
    ).resolves.toBe(false);
    expect(await failedAttempts(flow.id)).toBe(0);
  });

  it("counts every wrong code exactly once, and a correct code on the final attempt still succeeds", async () => {
    const flow = await insertFlow();

    // Spend four attempts on wrong codes.
    for (let attempt = 0; attempt < MAX_FAILED_VERIFICATION_ATTEMPTS - 1; attempt++) {
      const loaded = await loadEmailAuthFlow(db, "otp_login", flow.flowToken);
      expect(loaded).not.toBeNull();
      await expect(
        verifyEmailAuthFlowCode(db, env, "otp_login", loaded!, "000000"),
      ).rejects.toThrow("Invalid or expired code");
    }
    expect(await failedAttempts(flow.id)).toBe(MAX_FAILED_VERIFICATION_ATTEMPTS - 1);

    // The fifth attempt is still inside the budget: the correct code reserves,
    // compares, and the flow consumes exactly once.
    const loaded = (await loadEmailAuthFlow(db, "otp_login", flow.flowToken))!;
    await expect(
      verifyEmailAuthFlowCode(db, env, "otp_login", loaded, flow.code),
    ).resolves.toBeUndefined();
    await expect(consumeFlow(loaded)).resolves.toBe(true);
    await expect(consumeFlow(loaded)).resolves.toBe(false);
  });

  it("rejects even a correct code once the budget is spent", async () => {
    const flow = await insertFlow();

    for (let attempt = 0; attempt < MAX_FAILED_VERIFICATION_ATTEMPTS; attempt++) {
      const loaded = await loadEmailAuthFlow(db, "otp_login", flow.flowToken);
      await expect(
        verifyEmailAuthFlowCode(db, env, "otp_login", loaded!, "000000"),
      ).rejects.toThrow("Invalid or expired code");
    }

    // Exhausted at the reservation, so the correct code is never compared and
    // the flow can never be consumed by any verify path again.
    const loaded = await loadEmailAuthFlow(db, "otp_login", flow.flowToken);
    expect(loaded).toBeNull();
    await expect(
      verifyEmailAuthFlowCode(db, env, "otp_login", { id: flow.id, value: flow.value }, flow.code),
    ).rejects.toThrow("Invalid or expired code");
    await expect(
      db.query.verifications.findFirst({ where: { id: flow.id } }),
    ).resolves.toBeTruthy();
  });

  it("refuses consumption of a row whose attempts somehow exceed the budget", async () => {
    const flow = await insertFlow();

    // Simulate a row corrupted past the budget (the reservation predicate
    // makes this unreachable through real flows) — the consuming delete must
    // still refuse it, closing any direct-consume path around verification.
    await db
      .update(verifications)
      .set({
        data: JSON.stringify({
          version: 1,
          secretHash: "c".repeat(64),
          normalizedEmail: "user@example.com",
          recipientEmail: "user@example.com",
          userId: "user_1",
          failedAttempts: MAX_FAILED_VERIFICATION_ATTEMPTS + 1,
        }),
      })
      .where(eq(verifications.id, flow.id));

    await expect(
      consumeFlow({ id: flow.id, value: flow.value }),
    ).resolves.toBe(false);
  });
});
