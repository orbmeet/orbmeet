import { describe, expect, it } from "vitest";

import { CSP_NONCE_PLACEHOLDER } from "./csp-nonce";
import { buildMeetRouteCsp, buildProductionCsp } from "./csp";
import { addPrivateHtmlSecurityHeaders, secureApiResponse } from "./security-headers";

describe("media content security policy", () => {
  it("allows signed R2 recordings in every production document policy", () => {
    for (const csp of [buildProductionCsp(), buildMeetRouteCsp()]) {
      expect(csp).toContain(
        "media-src 'self' blob: https://*.r2.cloudflarestorage.com",
      );
    }
  });
});

describe("private HTML security headers", () => {
  it("replaces split nonce markers while preserving a streaming response", async () => {
    const html = `<html><script nonce="${CSP_NONCE_PLACEHOLDER}">boot()</script></html>`;
    const splitAt = html.indexOf(CSP_NONCE_PLACEHOLDER) + 8;
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(html.slice(0, splitAt)));
        controller.enqueue(encoder.encode(html.slice(splitAt)));
        controller.close();
      },
    });
    const response = addPrivateHtmlSecurityHeaders(new Response(body, {
      headers: {
        "Content-Length": String(html.length),
        "Content-Type": "text/html",
      },
    }));

    const csp = response.headers.get("Content-Security-Policy") ?? "";
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce).toMatch(/^[A-Za-z0-9+/]{24}$/);
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    expect(response.headers.get("Content-Length")).toBeNull();
    await expect(response.text()).resolves.toBe(
      html.replaceAll(CSP_NONCE_PLACEHOLDER, nonce ?? ""),
    );
  });
});

describe("secureApiResponse", () => {
  const finish = (response: Response, enableHSTS = false) =>
    secureApiResponse(response, { requestId: "req_1", enableHSTS });

  it("adds baseline headers, a private no-store default and the request id", () => {
    const decorated = finish(
      new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      }),
    );

    expect(decorated.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(decorated.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(decorated.headers.get("Cross-Origin-Resource-Policy")).toBe("same-site");
    expect(decorated.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    expect(decorated.headers.get("Cache-Control")).toBe("private, no-store");
    expect(decorated.headers.get("X-Request-ID")).toBe("req_1");
    expect(decorated.headers.get("Content-Type")).toBe("application/json");
    expect(decorated.headers.get("Strict-Transport-Security")).toBeNull();
  });

  it("keeps a header the handler already chose", () => {
    const decorated = finish(
      new Response("bytes", {
        headers: {
          "Cross-Origin-Resource-Policy": "cross-origin",
          "Cache-Control": "public, max-age=3600",
          "Content-Security-Policy": "default-src 'none'; style-src-attr 'unsafe-inline'",
        },
      }),
    );

    expect(decorated.headers.get("Cross-Origin-Resource-Policy")).toBe("cross-origin");
    expect(decorated.headers.get("Cache-Control")).toBe("public, max-age=3600");
    expect(decorated.headers.get("Content-Security-Policy")).toBe("default-src 'none'; style-src-attr 'unsafe-inline'");
  });

  it("pins HTTPS when the deployment serves it", () => {
    expect(finish(new Response("ok"), true).headers.get("Strict-Transport-Security")).toContain("max-age=");
  });

  it("does not attach a body to a bodiless status", async () => {
    const decorated = finish(new Response(null, { status: 204 }));
    expect(decorated.status).toBe(204);
    expect(decorated.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });
});
