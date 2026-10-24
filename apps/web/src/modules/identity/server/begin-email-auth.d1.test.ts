import { beforeEach, describe, expect, it, vi } from "vitest";
import { sessions, users, verifications } from "@orbmeet/db/schema";
import { createTestDb, type TestDb } from "@/test/db";

const mocks = vi.hoisted(() => ({
  sendEmail: vi.fn<(...args: unknown[]) => Promise<boolean>>(),
  buildOtpEmail: vi.fn<(code: string) => { subject: string; html: string; text: string }>(),
  ipLimit: vi.fn<(...args: unknown[]) => Promise<void>>(),
  addressLimit: vi.fn<(...args: unknown[]) => Promise<void>>(),
}));

vi.mock("@/platform/email/delivery", () => ({
  sendEmail: mocks.sendEmail,
  buildOtpEmail: mocks.buildOtpEmail,
  isEmailConfigured: (binding: unknown) => Boolean(binding),
  AUTOMATED_EMAIL_HEADERS: { "Auto-Submitted": "auto-generated" },
}));
vi.mock("@/platform/http/rate-limit.server", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/platform/http/rate-limit.server")>(),
  enforceIpRateLimit: mocks.ipLimit,
  enforceRateLimit: mocks.addressLimit,
}));
vi.mock("@/platform/http/client-ip.server", () => ({
  getClientIP: () => "192.0.2.1",
}));
vi.mock("@/platform/runtime/cloudflare-context", () => ({ readCloudflareContext: () => null }));

import { beginEmailAuthentication } from "./begin-email-auth.server";
import { loadEmailAuthFlow, verifyEmailAuthFlowCode } from "./email-flow";

let db: TestDb;
const env = {
  AUTH_SECRET: "test-auth-secret-with-at-least-32-characters",
  EMAIL: { send: async () => ({ messageId: "test" }) },
  EMAIL_FROM_ADDRESS: "Orb Meet <test@example.com>",
} as unknown as Env;

beforeEach(async () => {
  db = await createTestDb();
  vi.resetAllMocks();
  mocks.sendEmail.mockResolvedValue(true);
  mocks.buildOtpEmail.mockImplementation((code) => ({ subject: "Verification", html: code, text: code }));
  mocks.ipLimit.mockResolvedValue(undefined);
  mocks.addressLimit.mockResolvedValue(undefined);
});

async function registerUser(email = "person@gmail.com") {
  await db.insert(users).values({
    id: "existing_user", name: "Existing Person", email, normalizedEmail: email,
    plan: "free", role: "user", createdAt: new Date(), updatedAt: new Date(),
  });
}

describe("email-first authentication", () => {
  it("asks an unknown address for a name without sending mail or creating an account", async () => {
    await expect(beginEmailAuthentication(db, env, { email: "  new@example.com  " }))
      .resolves.toEqual({ step: "profile", email: "new@example.com" });
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(await db.select().from(users)).toEqual([]);
    expect(await db.select().from(verifications)).toEqual([]);
    expect(mocks.ipLimit).toHaveBeenCalledWith(env, "login");
    expect(mocks.addressLimit).toHaveBeenCalledWith(env, "login:new@example.com:192.0.2.1", true);
  });

  it("sends existing accounts a login code, normalizing aliases without exposing the stored email", async () => {
    await registerUser();
    const result = await beginEmailAuthentication(db, env, { email: "P.er.son+work@googlemail.com" });
    expect(result).toMatchObject({ step: "verify", mode: "login", email: "P.er.son+work@googlemail.com" });
    if (result.step !== "verify") throw new Error("Expected verification");
    expect(mocks.sendEmail).toHaveBeenCalledWith(env.EMAIL, expect.objectContaining({ to: "person@gmail.com" }));
    const flow = await loadEmailAuthFlow(db, "otp_login", result.flowToken);
    expect(flow?.data.userId).toBe("existing_user");
    const code = mocks.buildOtpEmail.mock.calls[0][0];
    await expect(verifyEmailAuthFlowCode(db, env, "otp_login", flow!, code)).resolves.toBeUndefined();
    expect(await db.select().from(sessions)).toEqual([]);
  });

  it("sends new users a signup code but does not create an account or session before verification", async () => {
    const result = await beginEmailAuthentication(db, env, { email: "new@example.com", name: "  New Person  " });
    expect(result).toMatchObject({ step: "verify", mode: "signup" });
    if (result.step !== "verify") throw new Error("Expected verification");
    const flow = await loadEmailAuthFlow(db, "otp_signup", result.flowToken);
    expect(flow?.data).toMatchObject({ name: "New Person", recipientEmail: "new@example.com", userId: null });
    const code = mocks.buildOtpEmail.mock.calls[0][0];
    await expect(verifyEmailAuthFlowCode(db, env, "otp_signup", flow!, code)).resolves.toBeUndefined();
    await expect(loadEmailAuthFlow(db, "otp_login", result.flowToken)).resolves.toBeNull();
    expect(await db.select().from(users)).toEqual([]);
    expect(await db.select().from(sessions)).toEqual([]);
  });

  it("switches to login if the account was created between the email and name steps", async () => {
    await expect(beginEmailAuthentication(db, env, { email: "person@gmail.com" }))
      .resolves.toMatchObject({ step: "profile" });
    await registerUser();
    await expect(beginEmailAuthentication(db, env, { email: "person@gmail.com", name: "Replacement Name" }))
      .resolves.toMatchObject({ step: "verify", mode: "login" });
    expect((await db.select().from(users))[0].name).toBe("Existing Person");
  });

  it("rejects invalid profile input and disposable signup addresses", async () => {
    await expect(beginEmailAuthentication(db, env, { email: "not-an-email" })).rejects.toThrow();
    await expect(beginEmailAuthentication(db, env, { email: "new@example.com", name: "  " })).rejects.toThrow();
    await expect(beginEmailAuthentication(db, env, { email: "person@mailinator.com" }))
      .rejects.toMatchObject({ code: "TEMPORARY_EMAIL" });
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it("applies request limits to both steps and prevents delivery when limited", async () => {
    mocks.ipLimit.mockRejectedValueOnce(new Error("IP limited"));
    await expect(beginEmailAuthentication(db, env, { email: "new@example.com" })).rejects.toThrow("IP limited");
    expect(mocks.addressLimit).not.toHaveBeenCalled();
    mocks.addressLimit.mockRejectedValueOnce(new Error("Address limited"));
    await expect(beginEmailAuthentication(db, env, { email: "new@example.com", name: "New Person" })).rejects.toThrow("Address limited");
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(await db.select().from(verifications)).toEqual([]);
  });

  it("keeps the delivery cooldown when an existing user submits repeatedly", async () => {
    await registerUser();
    await beginEmailAuthentication(db, env, { email: "person@gmail.com" });
    await expect(beginEmailAuthentication(db, env, { email: "person@gmail.com" }))
      .rejects.toThrow("Please wait before requesting another code");
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
  });

  it("reports delivery failure instead of returning a usable verification step", async () => {
    mocks.sendEmail.mockResolvedValue(false);
    await expect(beginEmailAuthentication(db, env, { email: "new@example.com", name: "New Person" }))
      .rejects.toThrow("Failed to send verification email");
    expect(await db.select().from(users)).toEqual([]);
    // Failed delivery cleans up the flow and releases the address cooldown.
    mocks.sendEmail.mockResolvedValue(true);
    await expect(beginEmailAuthentication(db, env, { email: "new@example.com", name: "New Person" }))
      .resolves.toMatchObject({ step: "verify", mode: "signup" });
  });
});
