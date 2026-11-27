import { describe, expect, it } from "vitest";
import {
  detectIpVersion,
  isPublicBrowserHost,
  isPublicIpAddress,
  isSafeExternalBrowserUrl,
  isSuspiciousHostname,
  normalizeIpv6,
  stripIpv6Brackets,
} from "./public-host.ts";

describe("detectIpVersion", () => {
  it("accepts canonical literals", () => {
    expect(detectIpVersion("8.8.8.8")).toBe(4);
    expect(detectIpVersion("0.0.0.0")).toBe(4);
    expect(detectIpVersion("2606:4700:4700::1111")).toBe(6);
    expect(detectIpVersion("::1")).toBe(6);
    expect(detectIpVersion("::ffff:192.168.1.1")).toBe(6);
  });

  it("rejects non-canonical encodings a browser would still resolve", () => {
    // Each of these resolves to 127.0.0.1 in a browser but is not a literal we
    // are willing to classify, so they fall through to the hostname rules.
    for (const value of ["0x7f000001", "2130706433", "017700000001", "127.1"]) {
      expect(detectIpVersion(value)).toBe(0);
    }
    expect(detectIpVersion("example.com")).toBe(0);
    expect(detectIpVersion("999.1.1.1")).toBe(0);
    expect(detectIpVersion("1.2.3.4.5")).toBe(0);
  });

  it("refuses non-canonical IPv4 encodings instead of treating them as hostnames", () => {
    // node:net's isIP rejects all of these, which previously let them skip the
    // private-range check and be classified as ordinary — public — hostnames.
    for (const value of ["127.0.0.01", "127.1", "10.0.0.5.6", "0177.0.0.1"]) {
      expect(detectIpVersion(value)).toBe(0);
      expect(isPublicIpAddress(value)).toBe(false);
      expect(isSuspiciousHostname(value)).toBe(true);
      expect(isPublicBrowserHost(value)).toBe(false);
    }
    expect(isSafeExternalBrowserUrl("http://127.0.0.01/admin")).toBe(false);
  });
});

describe("normalizeIpv6", () => {
  it("expands compressed and embedded-IPv4 forms", () => {
    expect(normalizeIpv6("::1")).toBe("0000:0000:0000:0000:0000:0000:0000:0001");
    expect(normalizeIpv6("::ffff:127.0.0.1")).toBe(
      "0000:0000:0000:0000:0000:ffff:7f00:0001",
    );
    expect(normalizeIpv6("0:0:0:0:0:0:0:1")).toBe(
      "0000:0000:0000:0000:0000:0000:0000:0001",
    );
  });

  it("rejects malformed literals", () => {
    expect(normalizeIpv6("zzzz::1")).toBeNull();
    // More than one compression run is ambiguous and must not be accepted.
    expect(normalizeIpv6("1::2::3")).toBeNull();
    // `::` has to stand in for at least one omitted group.
    expect(normalizeIpv6("1:2:3:4:5:6:7:8::")).toBeNull();
    expect(normalizeIpv6("1:2:3")).toBeNull();
    expect(normalizeIpv6("12345::1")).toBeNull();
    expect(normalizeIpv6("example.com")).toBeNull();
  });
});

describe("isSuspiciousHostname", () => {
  it("blocks intranet names with or without the absolute trailing dot", () => {
    for (const host of [
      "localhost",
      "localhost.",
      "ip6-localhost",
      "metadata.localhost",
      "metadata.localhost.",
      "printer.local",
      "printer.local.",
      "router.lan",
      "svc.internal",
      "1.0.0.127.in-addr.arpa",
      "",
      "intranet",
      "0x7f000001",
    ]) {
      expect(isSuspiciousHostname(host)).toBe(true);
    }
  });

  it("accepts IP literals and ordinary domains on its own", () => {
    // Literals are not "suspicious" — the private-range check is what rejects
    // them, which is why isPublicBrowserHost must run both.
    for (const host of ["127.0.0.1", "::1", "8.8.8.8", "example.com"]) {
      expect(isSuspiciousHostname(host)).toBe(false);
    }
  });

  it("sees through the brackets a URL puts around an IPv6 literal", () => {
    expect(isSuspiciousHostname("[::1]")).toBe(false);
    expect(stripIpv6Brackets("[::1]")).toBe("::1");
    expect(stripIpv6Brackets("example.com")).toBe("example.com");
  });
});

describe("isPublicBrowserHost", () => {
  it("rejects private, loopback, metadata, and CGNAT literals", () => {
    for (const host of [
      "127.0.0.1",
      "10.0.0.5",
      "172.16.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "::1",
      "::",
      "fd00::1",
      "fe80::1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "::7f00:1",
      "[::ffff:169.254.169.254]",
    ]) {
      expect(isPublicBrowserHost(host)).toBe(false);
    }
  });

  it("allows genuinely public hosts and IPs", () => {
    for (const host of [
      "example.com",
      "8.8.8.8",
      "2606:4700:4700::1111",
      "[2606:4700:4700::1111]",
      "::ffff:8.8.8.8",
    ]) {
      expect(isPublicBrowserHost(host)).toBe(true);
    }
  });
});

describe("isSafeExternalBrowserUrl", () => {
  it("accepts public http(s) URLs", () => {
    expect(isSafeExternalBrowserUrl("https://example.com/a?b=c")).toBe(true);
    expect(isSafeExternalBrowserUrl("http://example.com:8443/a")).toBe(true);
  });

  it("rejects non-http schemes, private hosts, and oversized values", () => {
    expect(isSafeExternalBrowserUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeExternalBrowserUrl("data:image/svg+xml,<svg/>")).toBe(false);
    expect(isSafeExternalBrowserUrl("file:///etc/passwd")).toBe(false);
    expect(isSafeExternalBrowserUrl("http://localhost:3000/x")).toBe(false);
    expect(isSafeExternalBrowserUrl("http://metadata.localhost/x")).toBe(false);
    expect(isSafeExternalBrowserUrl("http://127.0.0.1../x")).toBe(false);
    expect(isSafeExternalBrowserUrl("http://192.168.1.5/router")).toBe(false);
    expect(isSafeExternalBrowserUrl("http://[::1]/x")).toBe(false);
    expect(isSafeExternalBrowserUrl("not a url")).toBe(false);
    expect(isSafeExternalBrowserUrl("")).toBe(false);
    expect(isSafeExternalBrowserUrl(null)).toBe(false);
    expect(isSafeExternalBrowserUrl(`https://example.com/${"a".repeat(2048)}`)).toBe(false);
  });
});
