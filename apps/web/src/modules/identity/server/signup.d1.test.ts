import { env as workerEnv } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { users, verifications } from "@orbmeet/db/schema";
import { createTestDb, type TestDb } from "@/test/db";
import { hashOtp } from "@/modules/identity/server/crypto";
import { hashSessionToken } from "@/platform/crypto/tokens.server";

const env = { ...workerEnv, AUTH_SECRET: "test-auth-secret-with-at-least-32-characters" } as Env;

vi.mock("@tanstack/react-start/server", async (original) => ({
  ...await original<typeof import("@tanstack/react-start/server")>(),
  getRequest: () => new Request("https://orbmeet.test/verify", { headers: { "User-Agent": "test" } }),
}));
vi.mock("@/platform/runtime/server-runtime.server", () => ({ getEnv: async () => env }));
vi.mock("@/platform/http/rate-limit.server", () => ({
  enforceIpRateLimit: async () => {},
  enforceRateLimit: async () => {},
}));
vi.mock("@/platform/http/cookies.server", async (original) => ({
  ...await original<typeof import("@/platform/http/cookies.server")>(),
  appendCookies: () => {},
}));

import { verifyOtpImpl } from "./signup.server";

let db: TestDb;

beforeEach(async () => {
  db = await createTestDb();
});

async function insertSignupFlow() {
  const id = crypto.randomUUID();
  const secret = "a".repeat(64);
  const code = "123456";
  await db.insert(verifications).values({
    id,
    type: "otp_signup",
    identifier: `auth-flow:${id}`,
    value: await hashOtp(code, `otp_signup:${id}`, env.AUTH_SECRET),
    data: JSON.stringify({
      version: 1,
      secretHash: await hashSessionToken(secret),
      normalizedEmail: "ada@example.com",
      recipientEmail: "Ada@example.com",
      userId: null,
      name: "Ada",
      failedAttempts: 0,
    }),
    expiresAt: new Date(Date.now() + 600_000),
    updatedAt: new Date(),
  });
  return { flowToken: `${id}.${secret}`, otp: code };
}

describe("verifyOtpImpl", () => {
  it("returns the account as it was stored, defaults included", async () => {
    const { user } = await verifyOtpImpl({ data: await insertSignupFlow() });

    const [stored] = await db.select().from(users);
    expect(user).toEqual({
      id: stored.id,
      name: "Ada",
      email: "Ada@example.com",
      image: null,
      timeZone: null,
      appearance: "system",
      plan: "free",
      role: "user",
      subscriptionStatus: null,
      hasManagedSubscription: false,
    });
  });
});
