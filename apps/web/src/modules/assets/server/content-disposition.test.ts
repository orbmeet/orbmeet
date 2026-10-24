import { describe, expect, it } from "vitest";
import { buildAttachmentContentDisposition } from "./content-disposition";

describe("buildAttachmentContentDisposition", () => {
  it("removes control characters and quoted-string delimiters from the ASCII fallback", () => {
    const value = buildAttachmentContentDisposition('whiteboard-"demo\r\nX-Test: yes"\\.pdf');
    expect(value).toContain('filename="whiteboard-_demo__X-Test: yes__.pdf"');
    expect(value).not.toContain("\r");
    expect(value).not.toContain("\n");
    expect(value).toContain("filename*=UTF-8''");
  });

  it("percent-encodes characters encodeURIComponent leaves that are not RFC 5987 attr-chars", () => {
    const value = buildAttachmentContentDisposition("re*port'(v2).pdf");
    // `*`, `'` and `()` are not attr-chars, so none may appear raw in the ext-value.
    const extValue = value.split("filename*=UTF-8''")[1];
    expect(extValue).not.toMatch(/[*'()]/);
    expect(extValue).toContain("%2A"); // *
    expect(extValue).toContain("%27"); // '
    expect(extValue).toContain("%28"); // (
    expect(extValue).toContain("%29"); // )
  });
});
