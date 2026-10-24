import { describe, expect, it } from "vitest";

import { base64urlDecode, base64urlEncode } from "./crypto-utils.ts";

describe("base64urlDecode", () => {
  it("accepts unpadded base64url", () => {
    expect(base64urlDecode("YQ")).toEqual(new Uint8Array([97]));
  });

  it("rejects padding, whitespace, impossible lengths, and base64 alphabet aliases", () => {
    for (const encoded of ["YQ==", "Y Q", "A", "YQ+/", "YQ\n"]) {
      expect(() => base64urlDecode(encoded)).toThrow("Invalid base64url encoding");
    }
  });

  it("rejects the empty string like any other impossible encoding", () => {
    // Canonical behavior of @orbmeet/primitives: "" has no
    // bytes to verify, so it must fail instead of decoding to zero bytes.
    expect(() => base64urlDecode("")).toThrow("Invalid base64url encoding");
  });
});

describe("base64urlEncode", () => {
  it("is the inverse of the decoder for every byte value", () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, index) => index);
    expect(base64urlDecode(base64urlEncode(bytes))).toEqual(bytes);
  });
});
