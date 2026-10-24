import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  enforceRateLimit,
  enforceWebhookPreAuthRateLimit,
  rateLimitErrorResponse,
} from "./rate-limit.server";
import { logError } from "@/lib/logger";

vi.mock("@/lib/logger", () => ({
  logError: vi.fn(),
}));

function createEnv(overrides: Partial<Env> = {}): Env {
  return {
    APP_URL: "https://app.example",
    ENVIRONMENT: "production",
    RATE_LIMITER: undefined,
    AUTH_RATE_LIMITER: undefined,
    ...overrides,
  } as unknown as Env;
}

describe("enforceRateLimit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("spends the binding's budget", async () => {
    const limit = vi.fn().mockResolvedValueOnce({ success: true }).mockResolvedValueOnce({ success: false });
    const env = createEnv({ AUTH_RATE_LIMITER: { limit } as unknown as RateLimit });

    await expect(enforceRateLimit(env, "login:user@example.com", true)).resolves.toBeUndefined();
    await expect(enforceRateLimit(env, "login:user@example.com", true)).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(limit).toHaveBeenCalledWith({ key: "login:user@example.com" });
  });

  it("refuses without a binding, without logging the key", async () => {
    await expect(
      enforceRateLimit(createEnv({ ENVIRONMENT: "staging" }), "login:user@example.com", true),
    ).rejects.toMatchObject({ code: "CONFIG_ERROR" });

    expect(logError).toHaveBeenCalledTimes(1);
    const [message, payload] = vi.mocked(logError).mock.calls[0];
    expect(message).not.toContain("user@example.com");
    expect(payload).toMatchObject({ environment: "staging", keyScope: "login" });
    expect((payload as { keyHash: string }).keyHash).toMatch(/^[0-9a-f]{12}$/);
  });

  it("refuses without a binding on a remote deployment that calls itself development", async () => {
    await expect(
      enforceRateLimit(createEnv({ ENVIRONMENT: "development" }), "login:user@example.com", true),
    ).rejects.toMatchObject({ code: "CONFIG_ERROR" });
  });

  it("goes unlimited without a binding only in local development", async () => {
    const env = createEnv({ APP_URL: "http://localhost:3000", ENVIRONMENT: "development" });
    for (let attempt = 0; attempt < 200; attempt++) {
      await expect(enforceRateLimit(env, "login:user@example.com", true)).resolves.toBeUndefined();
    }
    expect(logError).not.toHaveBeenCalled();
  });
});

describe("webhook rate limiting", () => {
  it("uses independent provider bindings", async () => {
    const livekitLimit = vi.fn().mockResolvedValue({ success: true });
    const paddleLimit = vi.fn().mockResolvedValue({ success: true });
    const env = createEnv({
      LIVEKIT_WEBHOOK_RATE_LIMITER: { limit: livekitLimit },
      PADDLE_WEBHOOK_RATE_LIMITER: { limit: paddleLimit },
    });

    await enforceWebhookPreAuthRateLimit(env, "livekit");
    await enforceWebhookPreAuthRateLimit(env, "paddle");

    expect(livekitLimit).toHaveBeenCalledOnce();
    expect(paddleLimit).toHaveBeenCalledOnce();
  });

  it("distinguishes exhausted capacity from unavailable limiter infrastructure", () => {
    expect(rateLimitErrorResponse({ code: "RATE_LIMITED" }, "test").status).toBe(429);
    expect(rateLimitErrorResponse({ code: "CONFIG_ERROR" }, "test").status).toBe(503);
  });
});
