import { describe, expect, it } from "vitest";
import { isLoopbackHostname, isLoopbackUrl } from "./loopback";

describe("isLoopbackUrl", () => {
  it.each([
    "http://localhost:3000",
    "http://127.0.0.1:8787/x",
    "http://[::1]:3000/",
  ])("treats %s as loopback", (url) => {
    expect(isLoopbackUrl(url)).toBe(true);
  });

  it.each([
    "https://orbmeet.com",
    "http://localhost.evil.example",
    "http://127.0.0.2",
    "not a url",
    undefined,
  ])("does not treat %s as loopback", (url) => {
    expect(isLoopbackUrl(url)).toBe(false);
  });

  it("matches the bracketed form URL gives an IPv6 literal", () => {
    expect(isLoopbackHostname(new URL("http://[::1]/").hostname)).toBe(true);
    expect(isLoopbackHostname("::1")).toBe(false);
  });
});
