import { beforeEach, describe, expect, it } from "vitest";
import { verifications } from "@orbmeet/db/schema";
import { createTestDb, type TestDb } from "@/test/db";
import {
  consumePasskeyChallenge,
  isPasskeyChallengeId,
  PASSKEY_USER_VERIFICATION,
  REQUIRE_PASSKEY_USER_VERIFICATION,
} from "./passkey-policy";

let db: TestDb;

beforeEach(async () => {
  db = await createTestDb();
});

async function insertChallenge(
  type: "passkey_register" | "passkey_auth",
  identifier: string,
  expiresAt: Date,
) {
  const id = crypto.randomUUID();
  const createdAt = new Date(Math.min(Date.now(), expiresAt.getTime() - 10_000));
  await db.insert(verifications).values({
    id,
    type,
    identifier,
    value: "challenge",
    data: null,
    expiresAt,
    createdAt,
    updatedAt: createdAt,
  });
  return id;
}

describe("passkey policy", () => {
  it("requires authenticator user verification", () => {
    expect(PASSKEY_USER_VERIFICATION).toBe("required");
    expect(REQUIRE_PASSKEY_USER_VERIFICATION).toBe(true);
  });

  it("accepts only UUID v4 challenge IDs", () => {
    expect(isPasskeyChallengeId(crypto.randomUUID())).toBe(true);
    expect(isPasskeyChallengeId("short-id")).toBe(false);
    expect(isPasskeyChallengeId("00000000-0000-1000-8000-000000000000")).toBe(false);
  });

  it("atomically consumes a live challenge once", async () => {
    const identifier = "passkey-register:user_1";
    const id = await insertChallenge(
      "passkey_register",
      identifier,
      new Date(Date.now() + 60_000),
    );

    const first = await consumePasskeyChallenge(db, "passkey_register", identifier);
    const second = await consumePasskeyChallenge(db, "passkey_register", identifier);

    expect(first?.id).toBe(id);
    expect(second).toBeNull();
    expect(
      await db.query.verifications.findFirst({ where: { id: id } }),
    ).toBeUndefined();
  });

  it("does not consume an expired challenge", async () => {
    const identifier = "passkey-auth:expired";
    const id = await insertChallenge(
      "passkey_auth",
      identifier,
      new Date(Date.now() - 1_000),
    );

    expect(await consumePasskeyChallenge(db, "passkey_auth", identifier)).toBeNull();
    expect(
      await db.query.verifications.findFirst({ where: { id: id } }),
    ).toBeDefined();
  });
});
