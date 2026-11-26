import { describe, expect, it } from "vitest";
import { bytesToHex, hmacSha256, hmacSha256Hex, sha256Hex } from "./crypto.ts";

describe("bytesToHex", () => {
  it("encodes Uint8Array and ArrayBuffer inputs as lowercase hex", () => {
    const bytes = new Uint8Array([0x00, 0x0a, 0x10, 0xab, 0xff]);
    expect(bytesToHex(bytes)).toBe("000a10abff");
    expect(bytesToHex(bytes.buffer)).toBe("000a10abff");
    expect(bytesToHex(new Uint8Array())).toBe("");
  });
});

describe("sha256Hex", () => {
  it("matches standard SHA-256 test vectors for strings and bytes", async () => {
    // FIPS 180-4 empty string and "abc"
    expect(await sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(await sha256Hex(new TextEncoder().encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("hmacSha256 / hmacSha256Hex", () => {
  it("matches RFC 4231 test case 2 for string and byte inputs", async () => {
    const key = "Jefe";
    const data = "what do ya want for nothing?";
    const expected = "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843";

    const raw = await hmacSha256(key, data);
    expect(raw).toBeInstanceOf(Uint8Array);
    expect(raw).toHaveLength(32);
    expect(bytesToHex(raw)).toBe(expected);
    expect(await hmacSha256Hex(key, data)).toBe(expected);
    expect(
      await hmacSha256Hex(new TextEncoder().encode(key), new TextEncoder().encode(data)),
    ).toBe(expected);
  });
});
