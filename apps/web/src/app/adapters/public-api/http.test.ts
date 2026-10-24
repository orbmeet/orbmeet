import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  tokenIdFromRaw: vi.fn(() => null),
  enforceAutomationPreAuthRateLimit: vi.fn(),
  enforceRateLimit: vi.fn(),
  getOptionalEnv: vi.fn(),
}));

vi.mock("./bearer-auth", () => ({
  authenticateAutomationRequest: mocks.authenticate,
  tokenIdFromRaw: mocks.tokenIdFromRaw,
}));

vi.mock("@/platform/runtime/server-runtime.server", () => ({
  getOptionalEnv: mocks.getOptionalEnv,
}));

vi.mock("@/platform/http/rate-limit.server", () => ({
  enforceAutomationPreAuthRateLimit: mocks.enforceAutomationPreAuthRateLimit,
  enforceRateLimit: mocks.enforceRateLimit,
}));

import { handleAutomationApi, readAutomationJsonObject } from "./http";
import { Errors } from "@/lib/app-errors";

function jsonRequest(body: string): Request {
  return new Request("https://example.test/api/v1/schedules/1", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

describe("readAutomationJsonObject", () => {
  it("returns JSON objects", async () => {
    await expect(readAutomationJsonObject(jsonRequest('{"reason":"changed"}')))
      .resolves.toEqual({ reason: "changed" });
  });

  it.each(["null", "[]", '"text"', "42"])("rejects non-object JSON: %s", async (body) => {
    await expect(readAutomationJsonObject(jsonRequest(body)))
      .rejects.toThrow("Request body must be a JSON object");
  });
});

describe("handleAutomationApi", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getOptionalEnv.mockResolvedValue({ ENVIRONMENT: "production" });
    mocks.authenticate.mockResolvedValue({
      tokenId: "pat_valid",
      user: { id: "user_1" },
    });
  });

  it("rate limits the client IP before an invalid token can reach D1", async () => {
    mocks.enforceAutomationPreAuthRateLimit.mockRejectedValue(
      new Error("rate limiter rejected request"),
    );

    const response = await handleAutomationApi(
      new Request("https://example.test/api/v1/me", {
        headers: { Authorization: "Bearer orbmeet_pat_bogus." + "a".repeat(64) },
      }),
      null,
      async () => Response.json({ ok: true }),
    );

    expect(response.status).toBe(500);
    expect(mocks.enforceAutomationPreAuthRateLimit).toHaveBeenCalledWith(
      expect.objectContaining({ ENVIRONMENT: "production" }),
      null,
    );
    expect(mocks.authenticate).not.toHaveBeenCalled();
    expect(mocks.enforceRateLimit).not.toHaveBeenCalled();
  });

  it("keeps the authenticated token limiter after the pre-authentication limit", async () => {
    const order: string[] = [];
    mocks.enforceAutomationPreAuthRateLimit.mockImplementation(async () => {
      order.push("ip-limit");
    });
    mocks.authenticate.mockImplementation(async () => {
      order.push("authenticate");
      return { tokenId: "pat_valid", user: { id: "user_1" } };
    });
    mocks.enforceRateLimit.mockImplementation(async (...args: unknown[]) => {
      order.push(String(args[1]).startsWith("automation-user:") ? "user-limit" : "token-limit");
    });

    const response = await handleAutomationApi(
      new Request("https://example.test/api/v1/me"),
      null,
      async () => Response.json({ ok: true }),
    );

    expect(response.status).toBe(200);
    expect(order).toEqual(["ip-limit", "authenticate", "token-limit", "user-limit"]);
  });

  it("does not disclose infrastructure configuration errors", async () => {
    mocks.enforceAutomationPreAuthRateLimit.mockRejectedValue(
      Errors.CONFIG_ERROR("Rate limiter binding not configured"),
    );

    const response = await handleAutomationApi(
      new Request("https://example.test/api/v1/me"),
      null,
      async () => Response.json({ ok: true }),
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "INTERNAL_ERROR",
        message: "The request could not be completed",
      },
    });
  });
});
