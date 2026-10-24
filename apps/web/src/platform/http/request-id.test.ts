import { describe, expect, it } from "vitest";
import { getOrCreateRequestId, REQUEST_ID_HEADER } from "./request-id";

describe("request id", () => {
  it("keeps safe client request ids", () => {
    const request = new Request("https://example.com", {
      headers: { [REQUEST_ID_HEADER]: "req_abc-123.456" },
    });

    expect(getOrCreateRequestId(request)).toBe("req_abc-123.456");
  });

  it("replaces unsafe client request ids", () => {
    const request = new Request("https://example.com", {
      headers: { [REQUEST_ID_HEADER]: '"><script>alert(1)</script>' },
    });

    expect(getOrCreateRequestId(request)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});
