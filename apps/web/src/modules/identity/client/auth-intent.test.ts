import { describe, expect, it } from "vitest";

import { resolveAuthIntent } from "./auth-intent";

const DEFAULT_TITLE = "Welcome to Orb Meet";

describe("resolveAuthIntent", () => {
  it("names the errand for an invite link", () => {
    expect(resolveAuthIntent("/join/abcdefgh").title).toBe("Accept your invitation");
  });

  it("names the errand for a meeting code", () => {
    expect(resolveAuthIntent("/abc-defg-hij").title).toBe("Join the meeting");
  });

  it("names the errand for a Space", () => {
    expect(resolveAuthIntent("/space/design-studio").title).toBe("Open your Space");
  });

  it("falls back to the generic welcome with no redirect", () => {
    expect(resolveAuthIntent(undefined).title).toBe(DEFAULT_TITLE);
    expect(resolveAuthIntent("").title).toBe(DEFAULT_TITLE);
  });

  it("falls back for an app route with no errand to name", () => {
    expect(resolveAuthIntent("/settings").title).toBe(DEFAULT_TITLE);
  });

  it("refuses anything the redirect allowlist rejects", () => {
    // A bare 8-letter path is not `/join/…`, and an off-site URL never
    // survives sanitisation — neither may reach the invite copy.
    expect(resolveAuthIntent("/abcdefgh").title).toBe(DEFAULT_TITLE);
    expect(resolveAuthIntent("https://evil.example/join/abcdefgh").title).toBe(DEFAULT_TITLE);
    expect(resolveAuthIntent("//evil.example/join/abcdefgh").title).toBe(DEFAULT_TITLE);
    expect(resolveAuthIntent(42).title).toBe(DEFAULT_TITLE);
  });

  it("ignores a query string when matching", () => {
    expect(resolveAuthIntent("/join/abcdefgh?ref=slack").title).toBe("Accept your invitation");
  });
});
