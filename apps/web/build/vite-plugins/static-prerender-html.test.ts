import { describe, expect, it } from "vitest";
import { CSP_NONCE_PLACEHOLDER } from "../../src/platform/http/csp-nonce";
import { sanitizeStaticPrerenderHtml } from "./static-prerender-html";

describe("sanitizeStaticPrerenderHtml", () => {
  it("removes generated nonce attributes and router nonce metadata", () => {
    const html = [
      "<!doctype html><html><head>",
      `<meta property="csp-nonce" content="${CSP_NONCE_PLACEHOLDER}"/>`,
      `<link nonce="${CSP_NONCE_PLACEHOLDER}" rel="stylesheet" href="/app.css">`,
      "</head><body>",
      `<script nonce='${CSP_NONCE_PLACEHOLDER}'>boot()</script>`,
      "</body></html>",
    ].join("");

    const sanitized = sanitizeStaticPrerenderHtml(html);

    expect(sanitized).not.toContain(CSP_NONCE_PLACEHOLDER);
    expect(sanitized).not.toContain("csp-nonce");
    expect(sanitized).toContain('<link rel="stylesheet" href="/app.css">');
    expect(sanitized).toContain("<script>boot()</script>");
  });

  it("rejects placeholders in content it cannot safely classify", () => {
    expect(() =>
      sanitizeStaticPrerenderHtml(`<script>window.value = "${CSP_NONCE_PLACEHOLDER}"</script>`),
    ).toThrow("outside a recognized nonce attribute");
  });
});
