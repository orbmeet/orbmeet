import { describe, expect, it } from "vitest";
import { WebhookReceiver } from "livekit-server-sdk";
import { liveKitWebhookCreatedAt } from "./event-time";

describe("liveKitWebhookCreatedAt", () => {
  it("converts the bigint produced by WebhookReceiver", async () => {
    const event = await new WebhookReceiver("key", "secret").receive(
      JSON.stringify({
        id: "event-1",
        event: "participant_joined",
        createdAt: 1_787_097_600,
      }),
      undefined,
      true,
    );

    expect(typeof event.createdAt).toBe("bigint");
    expect(liveKitWebhookCreatedAt(event)).toEqual(new Date("2026-08-19T00:00:00.000Z"));
  });

  it("rejects missing/default and unsafe timestamps", () => {
    expect(liveKitWebhookCreatedAt({ createdAt: 0n })).toBeNull();
    expect(liveKitWebhookCreatedAt({ createdAt: BigInt(Number.MAX_SAFE_INTEGER) })).toBeNull();
  });
});
