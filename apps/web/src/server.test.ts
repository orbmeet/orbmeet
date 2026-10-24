import { describe, expect, it } from "vitest";
import { readdir, readFile } from "node:fs/promises";

import { handleApiRequest } from "./app/bootstrap/api-request";
import { isAutomationApiPath, isCsrfExemptApiPath } from "./app/bootstrap/request-policy";

const executionContext = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

describe("automation API request policy", () => {
  it("keeps the bearer-only surface narrowly enumerated", () => {
    expect(isAutomationApiPath("/api/v1/me")).toBe(true);
    expect(isAutomationApiPath("/api/v1/targets")).toBe(true);
    expect(isAutomationApiPath("/api/v1/meetings/")).toBe(true);
    expect(isAutomationApiPath("/api/v1/schedules/")).toBe(true);
    expect(isAutomationApiPath("/api/v1/schedules/msc_123")).toBe(true);
    expect(isAutomationApiPath("/api/v1/future-cookie-route")).toBe(false);
  });

  it("keeps every exempt v1 route behind scoped PAT authentication", async () => {
    const routeRoot = new URL("./routes/api/v1/", import.meta.url);
    const files = await readdir(routeRoot, { recursive: true });
    const routeFiles = files.filter((file) => file.endsWith(".ts"));
    expect(routeFiles.length).toBeGreaterThan(0);
    for (const file of routeFiles) {
      const source = await readFile(new URL(file, routeRoot), "utf8");
      expect(source, `${file} must authenticate through handleAutomationApi`)
        .toContain("handleAutomationApi(");
    }
  });

  it("rate limits billing callers before resolving cookie sessions", async () => {
    const routeRoot = new URL("./routes/api/billing/", import.meta.url);
    for (const file of ["checkout.ts", "portal.ts"]) {
      const source = await readFile(new URL(file, routeRoot), "utf8");
      const ipLimit = source.indexOf("await enforceIpRateLimit(");
      const sessionLookup = source.indexOf("await verifySessionFromRawRequest(");
      const userLimit = source.indexOf("await enforceRateLimit(");

      expect(ipLimit, `${file} must have a pre-authentication IP limit`).toBeGreaterThan(-1);
      expect(sessionLookup, `${file} must verify the cookie session`).toBeGreaterThan(ipLimit);
      expect(userLimit, `${file} must retain its per-user limit`).toBeGreaterThan(sessionLookup);
    }
  });

  it("returns bearer auth errors instead of CSRF errors to terminal clients", async () => {
    let preAuthLimitCalls = 0;
    const response = await handleApiRequest(
      new Request("https://app.orbmeet.com/api/v1/schedules/", {
        method: "POST",
        headers: {
          Authorization: "Bearer invalid",
          "Content-Type": "application/json",
        },
        body: "{}",
      }),
      {
        APP_URL: "https://app.orbmeet.com",
        ENVIRONMENT: "production",
        AUTH_SECRET: "test-production-auth-secret-with-32-characters",
        AUTOMATION_IP_RATE_LIMITER: {
          limit: async () => {
            preAuthLimitCalls += 1;
            return { success: true };
          },
        },
        AUTH_RATE_LIMITER: { limit: async () => ({ success: true }) },
      } as unknown as Env,
      executionContext,
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "UNAUTHORIZED" },
    });
    expect(preAuthLimitCalls).toBe(1);
  });

  it("rate limits malformed automation credentials before route dispatch", async () => {
    const response = await handleApiRequest(
      new Request("https://app.orbmeet.com/api/v1/me", {
        headers: { "CF-Connecting-IP": "203.0.113.10" },
      }),
      {
        APP_URL: "https://app.orbmeet.com",
        ENVIRONMENT: "production",
        AUTH_SECRET: "test-production-auth-secret-with-32-characters",
        AUTOMATION_IP_RATE_LIMITER: { limit: async () => ({ success: false }) },
        AUTH_RATE_LIMITER: { limit: async () => ({ success: true }) },
      } as unknown as Env,
      executionContext,
    );

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "RATE_LIMITED" },
    });
  });
});

describe("global CSRF exemptions", () => {
  it("allows only independently authenticated server-to-server endpoints", () => {
    expect(isCsrfExemptApiPath("/api/livekit/webhook")).toBe(true);
    expect(isCsrfExemptApiPath("/api/billing/webhook")).toBe(true);
    expect(isCsrfExemptApiPath("/api/internal/transcripts")).toBe(true);
    expect(isCsrfExemptApiPath("/api/email/unsubscribe")).toBe(true);
    expect(isCsrfExemptApiPath("/api/v1/me")).toBe(true);

    expect(isCsrfExemptApiPath("/api/email/unsubscribe/anything")).toBe(false);
    expect(isCsrfExemptApiPath("/api/email/send")).toBe(false);
    expect(isCsrfExemptApiPath("/api/billing/checkout")).toBe(false);
    expect(isCsrfExemptApiPath("/api/internal/transcripts/anything")).toBe(false);
  });
});
