import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const handleStartRequest = vi.hoisted(() =>
  vi.fn(async (_request: Request, _env?: Env, _ctx?: ExecutionContext) =>
    new Response("Start response"),
  ),
);

vi.mock("./server", () => ({
  handleDocumentRequest: handleStartRequest,
  handleStartApiRequest: handleStartRequest,
}));

import {
  fetchRequest,
  isFilePath,
  isStartServerRequestPath,
} from "./worker-entry";

const executionContext = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
  props: {},
} as unknown as ExecutionContext;

// The Worker loads the whiteboard handler lazily. Its first import is a cold
// load of a large module graph; paying it here keeps it out of any one test's
// time budget.
beforeAll(async () => {
  await import("@/modules/whiteboards/server/http/handler");
}, 60_000);

beforeEach(() => {
  handleStartRequest.mockClear();
});

function productionEnv(assetFetch: (request: Request) => Promise<Response>) {
  return {
    APP_URL: "https://orbmeet.com",
    AUTH_SECRET: "test-auth-secret-that-is-long-enough-for-production",
    NODES: JSON.stringify({
      sg1: { media: { url: "wss://sg1.rtc.orbmeet.com", capacity: 60, keys: { "sg1-key": "sg1-secret" } } },
      my1: { media: { url: "wss://my1.rtc.orbmeet.com", capacity: 60, keys: { "my1-key": "my1-secret" } } },
    }),
    ENVIRONMENT: "production",
    ASSETS: { fetch: assetFetch },
  } as unknown as Env & {
    ASSETS: { fetch: (request: Request) => Promise<Response> };
  };
}

describe("Worker document routing", () => {
  it("dispatches every non-document Start endpoint to the Start handler", () => {
    expect(isStartServerRequestPath("/_serverFn/example")).toBe(true);
    expect(isStartServerRequestPath("/api/llms.json")).toBe(true);
    expect(isStartServerRequestPath("/llms.txt")).toBe(true);
    expect(isStartServerRequestPath("/meetings")).toBe(false);
  });

  it("answers a server function call that names no function with a 404, not Start's 500", async () => {
    for (const path of ["/_serverFn", "/_serverFn/"]) {
      const response = await fetchRequest(
        new Request(`https://orbmeet.com${path}`),
        productionEnv(async () => new Response("asset")),
        executionContext,
      );
      expect(response.status).toBe(404);
    }
    expect(handleStartRequest).not.toHaveBeenCalled();
  });

  it("hands Start the request under the id its response will carry", async () => {
    await fetchRequest(
      new Request("https://orbmeet.com/meetings", { headers: { "X-Request-ID": "req-1" } }),
      productionEnv(async () => new Response("asset")),
      executionContext,
    );
    expect(handleStartRequest.mock.calls[0][0].headers.get("X-Request-ID")).toBe("req-1");
  });

  it("requires a live whiteboard bearer before routing MathInk to the origin", async () => {
    const originFetch = vi.fn(async () =>
      Response.json({ latex: "x", model_step: 70_000, latency_ms: 25 }),
    );
    vi.stubGlobal("fetch", originFetch);
    try {
      const response = await fetchRequest(
        new Request("https://orbmeet.com/api/mathink/v1/recognize", {
          method: "POST",
          headers: {
            "CF-Connecting-IP": "203.0.113.8",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ strokes: [[[0, 0], [1, 1]]] }),
        }),
        {
          ...productionEnv(async () => new Response("asset")),
          MATHINK_ORIGIN_URL: "https://origin.example/api/mathink",
          MATHINK_ORIGIN_SECRET: "test-secret",
          MATHINK_RATE_LIMITER: {
            limit: vi.fn(async () => ({ success: true })),
          },
        },
        executionContext,
      );

      expect(response.status).toBe(401);
      expect(originFetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects unauthenticated MathInk before reading its request body", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new TypeError("client disconnected"));
      },
    });
    const response = await fetchRequest(
      new Request("https://orbmeet.com/api/mathink/v1/recognize", {
        method: "POST",
        headers: {
          "CF-Connecting-IP": "203.0.113.8",
          "Content-Type": "application/json",
        },
        body,
        duplex: "half",
      } as RequestInit & { duplex: "half" }),
      {
        ...productionEnv(async () => new Response("asset")),
        MATHINK_RATE_LIMITER: { limit: vi.fn(async () => ({ success: true })) },
      },
      executionContext,
    );

    expect(response.status).toBe(401);
  });

  it("tells a file from a page by its last path segment", () => {
    expect(isFilePath("/assets/index-abc123.js")).toBe(true);
    expect(isFilePath("/favicon.svg")).toBe(true);
    expect(isFilePath("/meetings")).toBe(false);
    expect(isFilePath("/abc-defg-hij")).toBe(false);
    expect(isFilePath("/")).toBe(false);
  });

  it("renders pages through Start, whatever the request accepts", async () => {
    // Start's build-time prerender sends no Accept header.
    const assetFetch = vi.fn(async () => new Response("asset"));
    await fetchRequest(
      new Request("https://orbmeet.com/meetings?q=recent"),
      productionEnv(assetFetch),
      executionContext,
    );

    expect(handleStartRequest).toHaveBeenCalledOnce();
    expect(new URL(handleStartRequest.mock.calls[0][0].url).pathname).toBe("/meetings");
    expect(assetFetch).not.toHaveBeenCalled();
  });

  it("answers a missing file from Assets without rendering the app", async () => {
    const assetFetch = vi.fn(async () => new Response("missing", { status: 404 }));
    const response = await fetchRequest(
      new Request("https://orbmeet.com/assets/missing.js"),
      productionEnv(assetFetch),
      executionContext,
    );

    expect(assetFetch).toHaveBeenCalledOnce();
    expect(handleStartRequest).not.toHaveBeenCalled();
    expect(response.status).toBe(404);
  });
});
