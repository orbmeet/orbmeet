import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { emailSuppressions } from "@orbmeet/db/schema";
import { createTestDb } from "@/test/db";
import { createUnsubscribeToken } from "@/platform/email/unsubscribe-token";
import { handleUnsubscribePost } from "./unsubscribe";

const SECRET = "test-production-auth-secret-with-32-characters";

describe("RFC 8058 one-click unsubscribe", () => {
  it("accepts a signed provider POST without browser Origin headers", async () => {
    const token = await createUnsubscribeToken("attendee@example.com", SECRET);
    const response = await handleUnsubscribePost(
      new Request(`https://app.orbmeet.com/api/email/unsubscribe?token=${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "List-Unsubscribe=One-Click",
      }),
      {
        ...env,
        APP_URL: "https://app.orbmeet.com",
        ENVIRONMENT: "production",
        AUTH_SECRET: SECRET,
      },
    );

    expect(response.status).toBe(200);
    const db = await createTestDb();
    await expect(db.select().from(emailSuppressions)).resolves.toEqual([
      expect.objectContaining({
        normalizedEmail: "attendee@example.com",
        reason: "unsubscribed",
      }),
    ]);
  });

  const testEnv = { ...env, APP_URL: "https://app.orbmeet.com", ENVIRONMENT: "production", AUTH_SECRET: SECRET };
  const formPost = (body: string) => new Request("https://app.orbmeet.com/api/email/unsubscribe", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  it("accepts the confirmation form's token in the body", async () => {
    const token = await createUnsubscribeToken("reader@example.com", SECRET);
    const response = await handleUnsubscribePost(formPost(new URLSearchParams({ token }).toString()), testEnv);
    expect(response.status).toBe(200);
  });

  it("refuses a body larger than the form ever sends, before reading it all", async () => {
    const response = await handleUnsubscribePost(formPost(`token=${"x".repeat(64 * 1_024)}`), testEnv);
    expect(response.status).toBe(413);
  });
});
