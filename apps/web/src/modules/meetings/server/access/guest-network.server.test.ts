import { describe, expect, it } from "vitest";
import { guestNetworkKey } from "./guest-network.server";

describe("guestNetworkKey", () => {
  it("is stable per meeting and network, and differs across meetings", async () => {
    const a = await guestNetworkKey("secret", "meeting_1", "2001:db8:1:2::1");
    expect(await guestNetworkKey("secret", "meeting_1", "2001:db8:1:2::9")).toBe(a);
    expect(await guestNetworkKey("secret", "meeting_2", "2001:db8:1:2::1")).not.toBe(a);
    expect(await guestNetworkKey("secret", "meeting_1", "unknown")).toBeNull();
  });
});
