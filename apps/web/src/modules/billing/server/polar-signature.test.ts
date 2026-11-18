import { describe, expect, it } from "vitest";
import { verifyPolarWebhookSignature } from "./polar-signature";

const NOW = Date.parse("2026-11-18T12:00:00Z");
const timestamp = String(Math.floor(NOW / 1000));
const body = JSON.stringify({ type: "subscription.updated", data: {} });

async function sign(keyBytes: Uint8Array, id: string, ts: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes as Uint8Array<ArrayBuffer>,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${ts}.${payload}`)));
  return `v1,${btoa(String.fromCharCode(...mac))}`;
}

// A Standard Webhooks secret (since 8 September 2026): the key is the base64 after `whsec_`.
const standardKey = new Uint8Array(24).map((_, index) => index + 1);
const standardSecret = `whsec_${btoa(String.fromCharCode(...standardKey))}`;
// An older Polar secret: the key is the whole string's bytes.
const legacySecret = "whsec_legacy-secret-not-base64!";

describe("verifyPolarWebhookSignature", () => {
  it("accepts a Standard Webhooks signature", async () => {
    const signature = await sign(standardKey, "msg_1", timestamp, body);
    await expect(verifyPolarWebhookSignature(body, { id: "msg_1", timestamp, signature }, standardSecret, NOW))
      .resolves.toBe(true);
  });

  it("accepts a signature made with an older secret's whole string as the key", async () => {
    const signature = await sign(new TextEncoder().encode(legacySecret), "msg_1", timestamp, body);
    await expect(verifyPolarWebhookSignature(body, { id: "msg_1", timestamp, signature }, legacySecret, NOW))
      .resolves.toBe(true);
  });

  it("accepts any one of several signatures, as during a secret rotation", async () => {
    const good = await sign(standardKey, "msg_1", timestamp, body);
    const signature = `v1,${btoa("not the right mac at all!!")} ${good}`;
    await expect(verifyPolarWebhookSignature(body, { id: "msg_1", timestamp, signature }, standardSecret, NOW))
      .resolves.toBe(true);
  });

  it("rejects a tampered body", async () => {
    const signature = await sign(standardKey, "msg_1", timestamp, body);
    await expect(verifyPolarWebhookSignature(`${body} `, { id: "msg_1", timestamp, signature }, standardSecret, NOW))
      .resolves.toBe(false);
  });

  it("rejects a valid signature outside the five-minute window", async () => {
    const stale = String(Math.floor(NOW / 1000) - 301);
    const signature = await sign(standardKey, "msg_1", stale, body);
    await expect(verifyPolarWebhookSignature(body, { id: "msg_1", timestamp: stale, signature }, standardSecret, NOW))
      .resolves.toBe(false);
  });

  it("rejects missing or malformed headers", async () => {
    await expect(verifyPolarWebhookSignature(body, { id: "", timestamp, signature: "v1,x" }, standardSecret, NOW))
      .resolves.toBe(false);
    await expect(verifyPolarWebhookSignature(body, { id: "msg_1", timestamp: "soon", signature: "v1,x" }, standardSecret, NOW))
      .resolves.toBe(false);
    await expect(verifyPolarWebhookSignature(body, { id: "msg_1", timestamp, signature: "v2,abc" }, standardSecret, NOW))
      .resolves.toBe(false);
  });
});
