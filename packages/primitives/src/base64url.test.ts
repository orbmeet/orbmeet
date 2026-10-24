import { describe, expect, it } from "vitest";

import { decodeBase64Url, encodeBase64Url } from "./base64url.ts";

describe("encodeBase64Url", () => {
  it("produces unpadded, URL-safe output", () => {
    expect(encodeBase64Url(new Uint8Array([0]))).toBe("AA");
    expect(encodeBase64Url(new Uint8Array([255]))).toBe("_w");
    expect(encodeBase64Url(new Uint8Array([251, 255]))).toBe("-_8");
    expect(encodeBase64Url(new TextEncoder().encode("hi there"))).not.toMatch(/[+/=]/);
  });

  it("round-trips every byte value", () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, index) => index);
    expect(decodeBase64Url(encodeBase64Url(bytes))).toEqual(bytes);
  });
});

describe("decodeBase64Url", () => {
  it("accepts unpadded input of every valid remainder length", () => {
    expect(decodeBase64Url("YQ")).toEqual(new Uint8Array([97]));
    expect(decodeBase64Url("YWI")).toEqual(new Uint8Array([97, 98]));
    expect(decodeBase64Url("YWJj")).toEqual(new Uint8Array([97, 98, 99]));
  });

  it("rejects the empty string instead of yielding empty bytes", () => {
    // Every decoder consumer expects a signature, key, token payload, or JSON
    // cursor, so an empty value must fail closed instead of yielding zero bytes.
    expect(decodeBase64Url("")).toBeNull();
  });

  it("rejects padding, whitespace, impossible lengths, and base64 alphabet aliases", () => {
    for (const encoded of ["YQ==", "Y Q", "A", "YQ+/", "YQ\n", "ÜQ"]) {
      expect(decodeBase64Url(encoded)).toBeNull();
    }
  });

  it("rejects noncanonical encodings with non-zero unused bits", () => {
    for (const encoded of ["YR", "YS", "YT", "YWJ", "YWK", "YWL"]) {
      expect(decodeBase64Url(encoded)).toBeNull();
    }
  });
});
