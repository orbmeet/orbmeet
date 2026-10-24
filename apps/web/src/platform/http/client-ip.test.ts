import { afterEach, describe, expect, it, vi } from "vitest";
import { getClientIPFromRequest, networkOf } from "./client-ip";

const LOCAL = { appUrl: "http://localhost:3000", environment: "development" };
const PRODUCTION = { appUrl: "https://app.example", environment: "production" };
const MISCONFIGURED = { appUrl: "https://app.example", environment: "development" };

function request(headers: Record<string, string>) {
  return new Request("https://app.test/api/x", { headers });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getClientIPFromRequest", () => {
  it("takes Cloudflare's connecting IP everywhere", () => {
    const req = request({ "CF-Connecting-IP": "203.0.113.7", "X-Forwarded-For": "198.51.100.1" });
    expect(getClientIPFromRequest(req, PRODUCTION)).toBe("203.0.113.7");
    expect(getClientIPFromRequest(req, LOCAL)).toBe("203.0.113.7");
  });

  it("trusts forwarding headers only in development", () => {
    const req = request({ "X-Forwarded-For": "198.51.100.1, 10.0.0.1", "X-Real-IP": "198.51.100.2" });
    expect(getClientIPFromRequest(req, LOCAL)).toBe("198.51.100.1");
    expect(getClientIPFromRequest(request({ "X-Real-IP": "198.51.100.2" }), LOCAL)).toBe("198.51.100.2");
  });

  it("does not trust forwarding headers on a remote deployment that calls itself development", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(getClientIPFromRequest(request({ "X-Forwarded-For": "198.51.100.1" }), MISCONFIGURED)).toBe("unknown");
  });

  it("shares one fail-closed bucket when production lacks Cloudflare's header", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const req = request({ "X-Forwarded-For": "198.51.100.1" });
    expect(getClientIPFromRequest(req, PRODUCTION)).toBe("unknown");
    expect(getClientIPFromRequest(req, undefined)).toBe("unknown");
  });
});

describe("networkOf", () => {
  it("keeps an IPv4 address whole, mapped or not", () => {
    expect(networkOf("203.0.113.7")).toBe("203.0.113.7");
    expect(networkOf("::ffff:203.0.113.7")).toBe("203.0.113.7");
  });

  it("names an IPv6 client by its /64, however it is written", () => {
    const full = networkOf("2001:0db8:0001:0002:aaaa:bbbb:cccc:dddd");
    expect(full).toBe("2001:db8:1:2::/64");
    expect(networkOf("2001:db8:1:2::1")).toBe(full);
    expect(networkOf("2001:DB8:1:2:ffff::")).toBe(full);
    expect(networkOf("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(networkOf("::1")).toBe("0:0:0:0::/64");
  });

  it("refuses what is not an address", () => {
    for (const value of ["unknown", "", "2001:db8::1::2", "1:2:3:4:5:6:7:8:9", "gggg::1"]) {
      expect(networkOf(value)).toBeNull();
    }
  });
});
