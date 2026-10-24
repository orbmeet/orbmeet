import { beforeEach, describe, expect, it, vi } from "vitest";
import { verifications } from "@orbmeet/db/schema";
import { and, eq, notLike } from "drizzle-orm";
import { createTestDb, type TestDb } from "@/test/db";

const email = vi.hoisted(() => ({
  sendEmail: vi.fn<(binding: unknown, options: unknown) => Promise<boolean>>(),
}));

const requester = vi.hoisted(() => ({ ip: "203.0.113.7" }));

vi.mock("@/platform/http/client-ip.server", () => ({
  getClientIP: () => requester.ip,
}));

vi.mock("@/platform/email/delivery", () => ({
  buildOtpEmail: () => ({ subject: "Verification", html: "<p>Code</p>", text: "Code" }),
  sendEmail: email.sendEmail,
  isEmailConfigured: (binding: unknown) => Boolean(binding),
  AUTOMATED_EMAIL_HEADERS: { "Auto-Submitted": "auto-generated" },
}));

import {
  createEmailAuthFlow,
  EMAIL_DELIVERY_DAILY_CAP,
  loadEmailAuthFlow,
  resendEmailAuthFlowCode,
  verifyEmailAuthFlowCode,
} from "./email-flow";

let db: TestDb;
const env = {
  AUTH_SECRET: "test-auth-secret-with-at-least-32-characters",
  EMAIL: { send: async () => ({ messageId: "msg_test" }) },
  EMAIL_FROM_ADDRESS: "Orb Meet <test@example.com>",
} as unknown as Env;

beforeEach(async () => {
  db = await createTestDb();
  email.sendEmail.mockReset();
  requester.ip = "203.0.113.7";
});

function createFlow() {
  return createEmailAuthFlow(db, env, {
    type: "otp_signup",
    deliveryPurpose: "signup",
    deliverySubject: "user@example.com",
    data: {
      normalizedEmail: "user@example.com",
      recipientEmail: "user@example.com",
      userId: null,
      name: "User",
    },
  });
}

/** Expire every per-minute lease, leaving the day counters to accumulate. */
function expireLeases() {
  return db
    .update(verifications)
    .set({
      createdAt: new Date(Date.now() - 2_000),
      expiresAt: new Date(Date.now() - 1_000),
    })
    .where(and(eq(verifications.type, "otp_delivery"), notLike(verifications.identifier, "daily:%")));
}

describe("email authentication delivery", () => {
  it("does not resolve the auth flow before the provider accepts the email", async () => {
    let acceptDelivery!: (accepted: boolean) => void;
    email.sendEmail.mockReturnValue(new Promise((resolve) => {
      acceptDelivery = resolve;
    }));

    let settled = false;
    const flowPromise = createFlow().finally(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    acceptDelivery(true);
    await expect(flowPromise).resolves.toMatchObject({
      flowId: expect.any(String),
      flowToken: expect.any(String),
    });
  });

  it("removes the unusable flow and reports a provider failure", async () => {
    email.sendEmail.mockResolvedValue(false);

    await expect(createFlow()).rejects.toThrow(
      "Failed to send verification email. Please try again.",
    );
    const authFlows = await db
      .select({ id: verifications.id })
      .from(verifications)
      .where(eq(verifications.type, "otp_signup"));
    expect(authFlows).toEqual([]);
  });

  it("preserves failed attempts when replacing a code", async () => {
    email.sendEmail.mockResolvedValue(true);
    const created = await createFlow();
    const flow = await loadEmailAuthFlow(db, "otp_signup", created.flowToken);
    expect(flow).not.toBeNull();

    await expect(
      verifyEmailAuthFlowCode(db, env, "otp_signup", flow!, "not-the-issued-code"),
    ).rejects.toThrow("Invalid or expired code");

    // Expire the delivery cooldown without waiting for wall-clock time.
    const expiredAt = new Date(Date.now() - 1_000);
    await db
      .update(verifications)
      .set({
        createdAt: new Date(expiredAt.getTime() - 1_000),
        expiresAt: expiredAt,
      })
      .where(eq(verifications.type, "otp_delivery"));

    await expect(resendEmailAuthFlowCode(db, env, {
      type: "otp_signup",
      deliveryPurpose: "signup",
      flowToken: created.flowToken,
    })).resolves.toBe(true);

    const resent = await loadEmailAuthFlow(db, "otp_signup", created.flowToken);
    expect(resent?.data.failedAttempts).toBe(1);
  });

  it("caps how many codes one requester can have sent to an address per day", async () => {
    email.sendEmail.mockResolvedValue(true);

    for (let sent = 0; sent < EMAIL_DELIVERY_DAILY_CAP; sent += 1) {
      await expect(createFlow()).resolves.toBeDefined();
      await expireLeases();
    }

    // The next one is refused on the daily cap, not the minute lease.
    await expect(createFlow()).rejects.toThrow("Please wait before requesting another code");
  });

  it("does not let one requester spend another's codes for the same address", async () => {
    email.sendEmail.mockResolvedValue(true);

    requester.ip = "198.51.100.1";
    for (let sent = 0; sent < EMAIL_DELIVERY_DAILY_CAP; sent += 1) {
      await createFlow();
      await expireLeases();
    }
    await expect(createFlow()).rejects.toThrow("Please wait before requesting another code");

    // The address's owner, elsewhere, still gets a code — and right away,
    // though the other requester has just held the minute lease.
    requester.ip = "2001:db8:1:2::1";
    await expect(createFlow()).resolves.toBeDefined();
  });
});
