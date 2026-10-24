import { describe, expect, it } from "vitest";
import { buildSecurityHeaders } from "../../src/platform/http/csp.ts";
import { renderHeadersFile } from "./static-asset-headers.ts";

describe("renderHeadersFile", () => {
  const rendered = renderHeadersFile("https://example.com");

  it("lets an asset-served document client-navigate into a whiteboard on any of this deployment's nodes", () => {
    expect(rendered).toContain("https://*.whiteboard.example.com");
    expect(rendered).toContain("wss://*.whiteboard.example.com");
  });

  it("serves the policy the Worker applies to a public document", () => {
    const worker = buildSecurityHeaders({
      enableHSTS: true,
      addonCspDomains: ["*.whiteboard.example.com"],
    });
    for (const [name, value] of Object.entries(worker)) {
      expect(rendered).toContain(`  ${name}: ${value}\n`);
    }
  });

  it("never requires a request-time nonce, which static files cannot carry", () => {
    expect(rendered).not.toMatch(/script-src[^\n]*'nonce-/);
  });
});
