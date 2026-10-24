import { describe, expect, it } from "vitest";

import {
  buildUnsubscribeHeaders,
  createUnsubscribeToken,
  readUnsubscribeToken,
} from "./unsubscribe-token";

const SECRET = "test-auth-secret-with-at-least-32-characters";

describe("unsubscribe tokens", () => {
  it("round-trips the normalized address", async () => {
    const token = await createUnsubscribeToken("  Person@Example.COM ", SECRET);
    await expect(readUnsubscribeToken(token, SECRET)).resolves.toBe("person@example.com");
  });

  it("stays URL-safe so mail clients cannot mangle it", async () => {
    const token = await createUnsubscribeToken("a+b@example.com", SECRET);
    expect(token).toMatch(/^u1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(encodeURIComponent(token)).toBe(token);
  });

  it("rejects a token signed with another secret", async () => {
    const token = await createUnsubscribeToken("person@example.com", SECRET);
    await expect(readUnsubscribeToken(token, `${SECRET}-other`)).resolves.toBeNull();
  });

  // Without a signature anyone could unsubscribe any address by editing the URL.
  it("rejects a token whose address was swapped", async () => {
    const token = await createUnsubscribeToken("person@example.com", SECRET);
    const [version, , signature] = token.split(".");
    const forgedPayload = btoa("victim@example.com")
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    await expect(
      readUnsubscribeToken(`${version}.${forgedPayload}.${signature}`, SECRET),
    ).resolves.toBeNull();
  });

  it("rejects malformed and wrong-version tokens", async () => {
    const token = await createUnsubscribeToken("person@example.com", SECRET);
    await expect(readUnsubscribeToken("", SECRET)).resolves.toBeNull();
    await expect(readUnsubscribeToken("not.a.token", SECRET)).resolves.toBeNull();
    await expect(readUnsubscribeToken(token.replace(/^u1/, "u2"), SECRET)).resolves.toBeNull();
    await expect(readUnsubscribeToken(token.split(".").slice(1).join("."), SECRET))
      .resolves.toBeNull();
  });

  it("builds an HTTPS one-click header pair", async () => {
    const headers = await buildUnsubscribeHeaders({
      email: "person@example.com",
      appUrl: "https://meet.example.com/",
      secret: SECRET,
    });
    expect(headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(headers["List-Unsubscribe"]).toMatch(
      /^<https:\/\/meet\.example\.com\/api\/email\/unsubscribe\?token=u1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+>$/,
    );
    const token = headers["List-Unsubscribe"].replace(/^.*token=|>$/g, "");
    await expect(readUnsubscribeToken(token, SECRET)).resolves.toBe("person@example.com");
  });
});
