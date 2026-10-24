import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { verifications } from "@orbmeet/db/schema";
import { createTestDb, type TestDb } from "@/test/db";
import {
  preparePasskeyRegistrationGrant,
  preparePasskeyRegistrationGrantConsumption,
} from "./passkey-registration-grant";

let db: TestDb;
const appDb = () => db;

/** What passkey registration does with a grant: check it, then spend it in its own batch. */
async function consumeGrant(token: string, binding: { userId: string; authSessionId: string }) {
  const grant = await preparePasskeyRegistrationGrantConsumption(appDb(), token, binding);
  await db
    .delete(verifications)
    .where(and(eq(verifications.id, grant.id), eq(verifications.value, grant.value)));
}

beforeEach(async () => {
  db = await createTestDb();
});

async function insertGrant(userId = "user_1", sessionId = "session_1") {
  const now = new Date();
  const grant = await preparePasskeyRegistrationGrant(userId, sessionId, now);
  await db.insert(verifications).values({
    id: grant.id,
    type: "passkey_register",
    identifier: grant.identifier,
    value: grant.secretHash,
    data: grant.data,
    expiresAt: grant.expiresAt,
    createdAt: now,
    updatedAt: now,
  });
  return grant;
}

describe("post-signup passkey registration grants", () => {
  it("is bound to the exact user and authentication session", async () => {
    const grant = await insertGrant();

    await expect(
      consumeGrant(grant.token, {
        userId: "user_1",
        authSessionId: "different_session",
      }),
    ).rejects.toThrow("authorization expired");

    await expect(
      consumeGrant(grant.token, {
        userId: "different_user",
        authSessionId: "session_1",
      }),
    ).rejects.toThrow("authorization expired");
  });

  it("can be consumed only once", async () => {
    const grant = await insertGrant();
    const binding = { userId: "user_1", authSessionId: "session_1" };

    await expect(
      consumeGrant(grant.token, binding),
    ).resolves.toBeUndefined();
    await expect(
      consumeGrant(grant.token, binding),
    ).rejects.toThrow("authorization expired");
  });

  it("requires the browser-held secret", async () => {
    const grant = await insertGrant();
    const [id] = grant.token.split(".");

    await expect(
      consumeGrant(`${id}.${"f".repeat(64)}`,
        { userId: "user_1", authSessionId: "session_1" },
      ),
    ).rejects.toThrow("authorization expired");
  });
});
