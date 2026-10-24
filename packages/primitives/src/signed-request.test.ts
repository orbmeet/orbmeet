import { describe, expect, it } from "vitest";
import { parseKeyring, signRequest, verifySignedRequest } from "./signed-request.ts";

const SECRET_A = "a".repeat(40);
const SECRET_B = "b".repeat(40);
const NOW = 1_800_000_000;

function keyring(entries: Record<string, string>) {
  const parsed = parseKeyring(JSON.stringify(entries));
  if (!parsed) throw new Error("invalid test keyring");
  return parsed;
}

async function signed(body = '{"x":1}', ring = keyring({ primary: SECRET_A })) {
  return signRequest({ method: "POST", target: "/commands/restore?x=1", body, keyring: ring, nowSeconds: NOW });
}

describe("parseKeyring", () => {
  it("accepts a map of key ids to long secrets and rejects everything else", () => {
    expect(parseKeyring(JSON.stringify({ primary: SECRET_A, retiring: SECRET_B }))?.size).toBe(2);
    expect(parseKeyring(undefined)).toBeNull();
    expect(parseKeyring("not json")).toBeNull();
    expect(parseKeyring("{}")).toBeNull();
    expect(parseKeyring("[]")).toBeNull();
    expect(parseKeyring(JSON.stringify({ "bad id": SECRET_A }))).toBeNull();
    expect(parseKeyring(JSON.stringify({ primary: "short" }))).toBeNull();
    expect(parseKeyring(JSON.stringify({ primary: ` ${SECRET_A}` }))).toBeNull();
  });
});

describe("signed requests", () => {
  const verify = (header: string | null, overrides: Partial<Parameters<typeof verifySignedRequest>[0]> = {}) =>
    verifySignedRequest({
      header,
      method: "POST",
      target: "/commands/restore?x=1",
      body: '{"x":1}',
      keyring: keyring({ primary: SECRET_A }),
      nowSeconds: NOW,
      ...overrides,
    });

  it("verifies a request signed with the same keyring", async () => {
    expect(await verify(await signed())).toEqual({ ok: true, keyId: "primary" });
  });

  it("rejects a missing, malformed, or unknown-key header", async () => {
    expect(await verify(null)).toEqual({ ok: false, reason: "missing" });
    expect(await verify("v1,kid=primary")).toEqual({ ok: false, reason: "malformed" });
    const other = await signed(undefined, keyring({ other: SECRET_A }));
    expect(await verify(other)).toEqual({ ok: false, reason: "unknown_key" });
  });

  it("rejects a tampered body, method, or target", async () => {
    const header = await signed();
    expect(await verify(header, { body: '{"x":2}' })).toEqual({ ok: false, reason: "invalid" });
    expect(await verify(header, { method: "PUT" })).toEqual({ ok: false, reason: "invalid" });
    expect(await verify(header, { target: "/commands/archive?x=1" })).toEqual({ ok: false, reason: "invalid" });
  });

  it("rejects a request outside the skew window", async () => {
    const header = await signed();
    expect(await verify(header, { nowSeconds: NOW + 61 })).toEqual({ ok: false, reason: "expired" });
    expect(await verify(header, { nowSeconds: NOW - 61 })).toEqual({ ok: false, reason: "expired" });
    expect((await verify(header, { nowSeconds: NOW + 60 })).ok).toBe(true);
  });

  it("rotates: the new first key signs while the verifier still accepts the retiring key", async () => {
    const verifier = keyring({ next: SECRET_B, current: SECRET_A });
    const fromOldSigner = await signed(undefined, keyring({ current: SECRET_A }));
    const fromNewSigner = await signed(undefined, keyring({ next: SECRET_B, current: SECRET_A }));
    expect(await verify(fromOldSigner, { keyring: verifier })).toEqual({ ok: true, keyId: "current" });
    expect(await verify(fromNewSigner, { keyring: verifier })).toEqual({ ok: true, keyId: "next" });
  });

  it("signs byte bodies the same as their string form", async () => {
    const bytes = new TextEncoder().encode('{"x":1}');
    expect(await verify(await signed(), { body: bytes })).toEqual({ ok: true, keyId: "primary" });
  });
});
