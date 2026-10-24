import { afterEach, describe, expect, it, vi } from "vitest";

import { handleMathInkRequest } from "./proxy";

function testEnv(overrides: Partial<Env> = {}): Env {
  return {
    ENVIRONMENT: "production",
    MATHINK_ORIGIN_URL: "https://origin.example/api/mathink",
    MATHINK_ORIGIN_SECRET: "test-origin-secret",
    MATHINK_RATE_LIMITER: {
      limit: vi.fn(async () => ({ success: true })),
    },
    ...overrides,
  } as unknown as Env;
}

function recognitionRequest(body: unknown): Request {
  return new Request("https://orbmeet.com/api/mathink/v1/recognize", {
    method: "POST",
    headers: {
      "CF-Connecting-IP": "203.0.113.9",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MathInk proxy", () => {
  it("validates and forwards a bounded recognition request", async () => {
    const originFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("https://origin.example/api/mathink/v1/recognize");
      expect(new Headers(init?.headers).get("Authorization")).toBe(
        "Bearer test-origin-secret",
      );
      expect(JSON.parse(String(init?.body))).toEqual({
        strokes: [[[10, 20], [20, 10], [30, 20]]],
      });
      return Response.json({ latex: "x", model_step: 70000, latency_ms: 25 });
    });
    vi.stubGlobal("fetch", originFetch);

    const env = testEnv();
    const response = await handleMathInkRequest(
      recognitionRequest({ strokes: [[[10, 20], [20, 10], [30, 20]]] }),
      env,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ latex: "x", model_step: 70000, latency_ms: 25 });
    expect(env.MATHINK_RATE_LIMITER.limit).toHaveBeenCalledWith({
      key: "mathink:203.0.113.9",
    });
    expect(originFetch).toHaveBeenCalledOnce();
  });

  it("rejects malformed strokes without calling the origin", async () => {
    const originFetch = vi.fn();
    vi.stubGlobal("fetch", originFetch);

    const response = await handleMathInkRequest(
      recognitionRequest({ strokes: [[]] }),
      testEnv(),
    );

    expect(response.status).toBe(422);
    expect(originFetch).not.toHaveBeenCalled();
  });

  it("accepts a single-point stroke such as a dot", async () => {
    const originFetch = vi.fn(async () =>
      Response.json({ latex: ".", model_step: 70_000, latency_ms: 5 }),
    );
    vi.stubGlobal("fetch", originFetch);

    const response = await handleMathInkRequest(
      recognitionRequest({ strokes: [[[10, 20]]] }),
      testEnv(),
    );

    expect(response.status).toBe(200);
    expect(originFetch).toHaveBeenCalledOnce();
  });

  it("fails closed when the dedicated rate limiter rejects the client", async () => {
    const response = await handleMathInkRequest(
      recognitionRequest({ strokes: [[[0, 0], [1, 1]]] }),
      testEnv({
        MATHINK_RATE_LIMITER: {
          limit: vi.fn(async () => ({ success: false })),
        },
      }),
    );

    expect(response.status).toBe(429);
  });

  it("does not send the origin secret over plain HTTP in production", async () => {
    const originFetch = vi.fn();
    vi.stubGlobal("fetch", originFetch);

    const response = await handleMathInkRequest(
      recognitionRequest({ strokes: [[[0, 0], [1, 1]]] }),
      testEnv({ MATHINK_ORIGIN_URL: "http://origin.example/api/mathink" }),
    );

    expect(response.status).toBe(503);
    expect(originFetch).not.toHaveBeenCalled();
  });
});
