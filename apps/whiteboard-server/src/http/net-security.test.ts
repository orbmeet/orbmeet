import { beforeEach, describe, expect, it, vi } from "vitest";

const lookupMock = vi.hoisted(() => vi.fn());

vi.mock("node:dns/promises", () => ({
  lookup: lookupMock,
}));

describe("whiteboard network security helpers", () => {
  beforeEach(() => {
    lookupMock.mockReset();
  });

  it("rejects suspicious hostnames before DNS resolution", async () => {
    const { assertSafeUnfurlTarget, UnsafeUnfurlTargetError } = await import("./net-security.ts");

    await expect(assertSafeUnfurlTarget(new URL("http://localhost:8080/path"))).rejects.toEqual(
      expect.objectContaining({
        name: UnsafeUnfurlTargetError.name,
        message: "Hostname is not allowed",
      })
    );
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("rejects non-default ports before DNS resolution", async () => {
    const { assertSafeUnfurlTarget, UnsafeUnfurlTargetError } = await import("./net-security.ts");

    await expect(assertSafeUnfurlTarget(new URL("https://public.example:8443/x"))).rejects.toEqual(
      expect.objectContaining({
        name: UnsafeUnfurlTargetError.name,
        message: "Only default http/https ports are supported",
      })
    );
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("treats scheme-default ports as portless", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);

    const { assertSafeUnfurlTarget } = await import("./net-security.ts");

    // URL normalizes :443 on https away, so this is the default-port form.
    await expect(
      assertSafeUnfurlTarget(new URL("https://public.example:443/x"))
    ).resolves.toEqual(["93.184.216.34"]);
  });

  it("rejects hostnames that resolve to private addresses", async () => {
    lookupMock.mockResolvedValue([{ address: "10.0.0.8", family: 4 }]);

    const { assertSafeUnfurlTarget, UnsafeUnfurlTargetError } = await import("./net-security.ts");

    await expect(assertSafeUnfurlTarget(new URL("https://private.example"))).rejects.toEqual(
      expect.objectContaining({
        name: UnsafeUnfurlTargetError.name,
        message: "Resolved address is not public",
      })
    );
  });

  it("allows public hostnames that resolve to public addresses", async () => {
    lookupMock.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
    ]);

    const { assertSafeUnfurlTarget } = await import("./net-security.ts");

    // C5: now returns resolved IPs for DNS pinning
    const result = await assertSafeUnfurlTarget(new URL("https://example.com"));
    expect(result).toEqual(["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"]);
  });

  it("matches trusted proxy exact IPs and Docker bridge CIDRs", async () => {
    const { isTrustedProxyIp, parseTrustedProxyList } = await import("./net-security.ts");

    const trusted = parseTrustedProxyList("127.0.0.1,172.16.0.0/12");

    expect(isTrustedProxyIp("127.0.0.1", trusted)).toBe(true);
    expect(isTrustedProxyIp("172.19.0.4", trusted)).toBe(true);
    expect(isTrustedProxyIp("::ffff:172.19.0.4", trusted)).toBe(true);
    expect(isTrustedProxyIp("192.168.1.10", trusted)).toBe(false);
  });

  it("matches exact IPv6 proxies case-insensitively", async () => {
    const { isTrustedProxyIp, parseTrustedProxyList } = await import("./net-security.ts");
    const trusted = parseTrustedProxyList("2001:DB8::A");
    expect(isTrustedProxyIp("2001:db8::a", trusted)).toBe(true);
  });

  it("ignores malformed trusted proxy entries", async () => {
    const { isTrustedProxyIp, parseTrustedProxyList } = await import("./net-security.ts");

    const trusted = parseTrustedProxyList("bad-cidr,300.1.1.1,172.19.0.4/40,10.0.0.1");

    expect(trusted).toEqual([{ type: "exact", ip: "10.0.0.1" }]);
    expect(isTrustedProxyIp("10.0.0.1", trusted)).toBe(true);
    expect(isTrustedProxyIp("172.19.0.4", trusted)).toBe(false);
  });

  it("drops an entry with a second slash rather than reading the first prefix", async () => {
    const { isTrustedProxyIp, parseTrustedProxyList } = await import("./net-security.ts");

    // `10.0.0.0/8/16` used to lose its third segment to the destructuring and
    // parse as `/8`, trusting 16 million addresses an operator wrote a
    // narrower rule for.
    const trusted = parseTrustedProxyList("10.0.0.0/8/16,192.168.1.0/24");

    expect(isTrustedProxyIp("10.1.2.3", trusted)).toBe(false);
    expect(isTrustedProxyIp("10.0.0.1", trusted)).toBe(false);
    expect(isTrustedProxyIp("192.168.1.7", trusted)).toBe(true);
  });

  it("drops a prefix that is not a plain number", async () => {
    const { isTrustedProxyIp, parseTrustedProxyList } = await import("./net-security.ts");

    for (const entry of ["10.0.0.0/ 8", "10.0.0.0/0x8", "10.0.0.0/8e0", "10.0.0.0/"]) {
      expect(isTrustedProxyIp("10.0.0.1", parseTrustedProxyList(entry))).toBe(false);
    }
  });

  it("drops a CIDR base with zero-padded octets", async () => {
    const { isTrustedProxyIp, parseTrustedProxyList } = await import("./net-security.ts");

    // The same strict dotted-quad rule the SSRF guard applies: a zero-padded
    // octet is an alternate spelling, never an ordinary address.
    expect(parseTrustedProxyList("010.0.0.0/8,10.0.0.00/8")).toEqual([]);
    expect(isTrustedProxyIp("10.0.0.1", parseTrustedProxyList("010.0.0.0/8"))).toBe(false);
  });

  it("resolves the client IP from the rightmost untrusted X-Forwarded-For hop", async () => {
    const { resolveClientIp, parseTrustedProxyList } = await import("./net-security.ts");

    const trusted = parseTrustedProxyList("172.30.20.2");

    // Caddy (trusted) appends the real peer to the right of any client value.
    // The spoofed leftmost entry must be ignored.
    expect(resolveClientIp("1.2.3.4, 203.0.113.9", "172.30.20.2", trusted)).toBe("203.0.113.9");
    // Trailing trusted-proxy hops are skipped to reach the real client.
    expect(resolveClientIp("203.0.113.9, 172.30.20.2", "172.30.20.2", trusted)).toBe("203.0.113.9");
    // No header → fall back to the connecting peer.
    expect(resolveClientIp(null, "172.30.20.2", trusted)).toBe("172.30.20.2");
    // IPv4-mapped IPv6 forms are normalized.
    expect(resolveClientIp("::ffff:203.0.113.9", "172.30.20.2", trusted)).toBe("203.0.113.9");
  });

  it("rejects loopback IPv4 addresses", async () => {
    lookupMock.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);

    const { assertSafeUnfurlTarget, UnsafeUnfurlTargetError } = await import("./net-security.ts");

    await expect(assertSafeUnfurlTarget(new URL("https://loopback.example"))).rejects.toEqual(
      expect.objectContaining({ name: UnsafeUnfurlTargetError.name })
    );
  });

  it("rejects link-local addresses", async () => {
    lookupMock.mockResolvedValue([{ address: "169.254.169.254", family: 4 }]);

    const { assertSafeUnfurlTarget, UnsafeUnfurlTargetError } = await import("./net-security.ts");

    await expect(assertSafeUnfurlTarget(new URL("https://metadata.example"))).rejects.toEqual(
      expect.objectContaining({ name: UnsafeUnfurlTargetError.name })
    );
  });

  // IPv4-compatible ::a.b.c.d embeds an IPv4 in the low 32 bits but is NOT the
  // 0xffff-mapped form, so it must still be resolved to its embedded IPv4 and
  // rejected when that IPv4 is private/loopback/link-local.
  it.each([
    ["::7f00:1", "loopback 127.0.0.1"],
    ["::a9fe:1", "link-local 169.254.0.1"],
    ["::0a00:5", "private 10.0.0.5"],
    ["::c0a8:1", "private 192.168.0.1"],
  ])("rejects IPv4-compatible IPv6 %s (%s)", async (address) => {
    lookupMock.mockResolvedValue([{ address, family: 6 }]);

    const { assertSafeUnfurlTarget, UnsafeUnfurlTargetError } = await import("./net-security.ts");

    await expect(assertSafeUnfurlTarget(new URL("https://compat.example"))).rejects.toEqual(
      expect.objectContaining({ name: UnsafeUnfurlTargetError.name })
    );
  });

  it("allows a genuinely public IPv6 address", async () => {
    lookupMock.mockResolvedValue([{ address: "2606:4700:4700::1111", family: 6 }]);

    const { assertSafeUnfurlTarget } = await import("./net-security.ts");

    await expect(
      assertSafeUnfurlTarget(new URL("https://public-v6.example"))
    ).resolves.toEqual(["2606:4700:4700::1111"]);
  });

  describe("isPublicBrowserHost", () => {
    it("rejects literal private, loopback, and metadata IPs that isSuspiciousHostname accepts", async () => {
      const { isPublicBrowserHost, isSuspiciousHostname } = await import("@orbmeet/whiteboard-core/public-host");
      for (const host of [
        "127.0.0.1",
        "10.0.0.5",
        "192.168.1.1",
        "169.254.169.254",
        "::1",
      ]) {
        // Guards against the original bug: these are not "suspicious" on their own.
        expect(isSuspiciousHostname(host)).toBe(false);
        expect(isPublicBrowserHost(host)).toBe(false);
      }
    });

    it("still rejects blocked/suspicious hostnames", async () => {
      const { isPublicBrowserHost } = await import("@orbmeet/whiteboard-core/public-host");
      expect(isPublicBrowserHost("localhost")).toBe(false);
      expect(isPublicBrowserHost("printer.local")).toBe(false);
      expect(isPublicBrowserHost("0x7f000001")).toBe(false);
      expect(isPublicBrowserHost("")).toBe(false);
      expect(isPublicBrowserHost("localhost.")).toBe(false);
      expect(isPublicBrowserHost("printer.local.")).toBe(false);
      expect(isPublicBrowserHost("router.lan.")).toBe(false);
    });

    it("allows genuinely public hosts and IPs", async () => {
      const { isPublicBrowserHost } = await import("@orbmeet/whiteboard-core/public-host");
      expect(isPublicBrowserHost("example.com")).toBe(true);
      expect(isPublicBrowserHost("8.8.8.8")).toBe(true);
      expect(isPublicBrowserHost("2606:4700:4700::1111")).toBe(true);
    });
  });
});
