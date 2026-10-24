import { beforeEach, describe, expect, it, vi } from "vitest";

const responseHeaders = vi.hoisted(() => new Headers());

vi.mock("@tanstack/react-start/server", () => ({
  getResponseHeaders: () => responseHeaders,
  // Model the old read/rewrite APIs too, so this test fails if appendCookies
  // regresses to comma-folding Set-Cookie through Headers.get().
  getResponseHeader: (name: string) => responseHeaders.get(name) ?? undefined,
  setResponseHeader: (name: string, value: string | string[]) => {
    responseHeaders.delete(name);
    for (const item of Array.isArray(value) ? value : [value]) {
      responseHeaders.append(name, item);
    }
  },
}));

import {
  appendCookies,
  createCookieString,
  getCookieValue,
  getGuestCookieSecretFromCookie,
  getSessionIdsFromCookie,
} from "./cookies.server";

const PRODUCTION = { appUrl: "https://orbmeet.com", environment: "production" };
const LOCAL = { appUrl: "http://localhost:3000", environment: "development" };

describe("appendCookies", () => {
  beforeEach(() => {
    for (const name of responseHeaders.keys()) {
      responseHeaders.delete(name);
    }
  });

  it("preserves guest and whiteboard cookies as separate Set-Cookie fields", () => {
    const cookies = [
      "__Host-guest_admission_1=guest-secret; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=28800",
      "__Secure-wb_asset_meeting_1=meeting-token; Path=/api/wb-assets/; HttpOnly; Secure; SameSite=Lax; Max-Age=3600",
      "__Secure-wb_asset_sync_1=sync-token; Path=/api/wb-assets/; HttpOnly; Secure; SameSite=Lax; Max-Age=3600",
      "__Secure-wb_asset_board_1=board-token; Path=/api/wb-assets/; HttpOnly; Secure; SameSite=Lax; Max-Age=3600",
    ];

    appendCookies([cookies[0]]);
    appendCookies([cookies[1]]);
    appendCookies(cookies.slice(2));

    expect(responseHeaders.getSetCookie()).toEqual(cookies);
    expect(responseHeaders.getSetCookie()).not.toContain(
      expect.stringContaining(", __"),
    );
    expect(
      getGuestCookieSecretFromCookie(
        "__Host-guest_admission_1=guest-secret",
        "admission_1",
        PRODUCTION,
      ),
    ).toBe("guest-secret");
  });
});

describe("cookie names", () => {
  it("prefixes every Secure cookie so no other host can plant it", () => {
    expect(createCookieString("session", "t", 60, PRODUCTION))
      .toBe("__Host-session=t; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=60");
    expect(createCookieString("wb_asset_m", "t", 60, { ...PRODUCTION, path: "/api/wb-assets/" }))
      .toMatch(/^__Secure-wb_asset_m=t; Path=\/api\/wb-assets\/; HttpOnly; Secure;/);
  });

  it("keeps plain names over local HTTP, where a cookie cannot be Secure", () => {
    expect(createCookieString("session", "t", 60, LOCAL))
      .toBe("session=t; Path=/; HttpOnly; SameSite=Lax; Max-Age=60");
    expect(getSessionIdsFromCookie("session=local", LOCAL)).toEqual(["local"]);
  });

  it("ignores an unprefixed cookie in production, which a subdomain could have set", () => {
    const header = "session=planted; __Host-session=real; device=planted";
    expect(getSessionIdsFromCookie(header, PRODUCTION)).toEqual(["real"]);
    expect(getCookieValue(header, "device", PRODUCTION)).toBeNull();
  });
});

describe("cookie parsing", () => {
  it("continues past an empty duplicate cookie", () => {
    expect(getCookieValue("__Host-device=; __Host-device=live-token", "device", PRODUCTION))
      .toBe("live-token");
  });

  it("preserves duplicate session-cookie order for the bounded resolver policy", () => {
    const values = ["old-1", "old-2", "old-3", "old-4", "old-5", "current"];
    const parsed = getSessionIdsFromCookie(
      values.map((value) => `__Host-session=${value}`).join("; "),
      PRODUCTION,
    );
    expect([...new Set(parsed)].slice(-5)).toEqual([
      "old-2",
      "old-3",
      "old-4",
      "old-5",
      "current",
    ]);
  });
});
