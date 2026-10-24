import { beforeEach, describe, expect, it, vi } from "vitest";
import { CSP_NONCE_PLACEHOLDER } from "@/platform/http/csp-nonce";

// What Start renders is beside the point here: these tests cover the headers
// every document leaves the Worker with.
const startHandler = vi.hoisted(() => vi.fn<(request: Request) => Promise<Response>>());

vi.mock("@tanstack/react-start/server", () => ({
  createStartHandler: () => startHandler,
  defaultStreamHandler: {},
}));

import { handleDocumentRequest } from "./server";

const executionContext = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
  props: {},
} as unknown as ExecutionContext;

const env = {
  APP_URL: "https://orbmeet.com",
  AUTH_SECRET: "test-auth-secret-that-is-long-enough-for-production",
  NODES: JSON.stringify({
    sg1: { media: { url: "wss://sg1.rtc.orbmeet.com", capacity: 60, keys: { "sg1-key": "sg1-secret" } } },
    my1: { media: { url: "wss://my1.rtc.orbmeet.com", capacity: 60, keys: { "my1-key": "my1-secret" } } },
  }),
  ENVIRONMENT: "production",
} as unknown as Env;

function renderDocument(path: string) {
  return handleDocumentRequest(
    new Request(`https://orbmeet.com${path}`, { headers: { "Sec-Fetch-Mode": "navigate" } }),
    env,
    executionContext,
  );
}

beforeEach(() => {
  startHandler.mockReset();
  startHandler.mockImplementation(async () =>
    new Response(`<!doctype html><script nonce="${CSP_NONCE_PLACEHOLDER}">boot()</script>`, {
      headers: { "Content-Type": "text/html" },
    }));
});

describe("document responses", () => {
  it("gives an app document a fresh nonce, a private cache policy and noindex", async () => {
    const response = await renderDocument("/meetings?q=recent");

    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("X-Robots-Tag")).toBe("noindex");
    expect(response.headers.get("Permissions-Policy")).toContain("camera=()");
    const csp = response.headers.get("Content-Security-Policy");
    // The app can client-navigate from /meetings into a live Whiteboard
    // without another document response, so its policy already covers it.
    expect(csp).toContain("wss://*.whiteboard.orbmeet.com");
    expect(csp).toContain("'unsafe-eval'");
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    expect(csp).toContain("font-src 'self' data:");
    const body = await response.text();
    expect(body).not.toContain(CSP_NONCE_PLACEHOLDER);
    expect(csp).toContain(`'nonce-${/nonce="([^"]+)"/.exec(body)?.[1]}'`);
  });

  it("applies meeting permissions and every media node's signaling CSP to meeting documents", async () => {
    const response = await renderDocument("/abc-defg-hij");

    expect(response.headers.get("Permissions-Policy")).toContain("camera=(self)");
    const csp = response.headers.get("Content-Security-Policy");
    expect(csp).toContain("wss://sg1.rtc.orbmeet.com");
    expect(csp).toContain("wss://my1.rtc.orbmeet.com");
    expect(csp).toContain("wss://*.whiteboard.orbmeet.com");
  });

  it("leaves a public page indexable", async () => {
    // Assets serves the prerendered page; reaching Start means an Assets miss,
    // and a degraded response must not tell crawlers to drop the page.
    const response = await renderDocument("/pricing");

    expect(response.headers.get("X-Robots-Tag")).toBeNull();
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });
});
