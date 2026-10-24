import { describe, expect, it } from "vitest";
import { findOAuthStateCookie, oauthStateCookieName, oauthStateCookieNames } from "./oauth-state";

describe("oauth state cookies", () => {
  const hashA = "a".repeat(64);
  const hashB = "b".repeat(64);
  const cookieA = oauthStateCookieName("oauth_state", hashA);

  it("names one cookie per attempt", () => {
    expect(cookieA).toBe("oauth_state_aaaaaaaaaaaaaaaa");
    expect(oauthStateCookieName("oauth_link_state", hashB)).toBe("oauth_link_state_bbbbbbbbbbbbbbbb");
  });

  const options = { appUrl: "https://orbmeet.com", environment: "production" };

  it("finds the attempt's cookie only when it holds that attempt's hash", () => {
    const header = `__Host-session=x; __Host-${cookieA}=${hashA}; __Host-oauth_state_${"b".repeat(16)}=${hashB}`;
    const find = (cookie: string, baseName: "oauth_state" | "oauth_link_state") =>
      findOAuthStateCookie({ cookie, baseName, expectedHashHex: hashA, options });
    expect(find(header, "oauth_state")).toBe(cookieA);
    expect(find(`__Host-${cookieA}=${hashB}`, "oauth_state")).toBeNull();
    expect(find(header, "oauth_link_state")).toBeNull();
    // An unprefixed state cookie could have been planted by another host.
    expect(find(`${cookieA}=${hashA}`, "oauth_state")).toBeNull();
  });

  it("lists every attempt's cookie a request carries, and nothing else", () => {
    const link = oauthStateCookieName("oauth_link_state", hashB);
    expect(
      oauthStateCookieNames(`__Host-session=x; __Host-${cookieA}=${hashA}; ${link}=${hashB}; oauth_state=other; __Host-${cookieA}=dup`),
    ).toEqual([cookieA, link]);
    expect(oauthStateCookieNames(null)).toEqual([]);
  });
});
