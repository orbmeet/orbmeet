import { describe, expect, it } from "vitest";
import {
  isPublicBrowserHost,
  isPublicIpAddress,
  isPublicIpv4,
  isSafeExternalBrowserUrl,
  isStrictIpv4,
  isSuspiciousHostname,
  normalizeIpv6,
} from "./public-host.ts";
import { isWhiteboardRoomId, toWhiteboardRoomId } from "./whiteboard-room-id.ts";
import {
  createEmptyWhiteboardRoomSnapshot,
  validateWhiteboardRoomSnapshot,
} from "./room-snapshot-validation.ts";
import { whiteboardTLSchema } from "./room-schema.ts";

describe("public-host and asset security primitives", () => {
  describe("IPv4 Strict Classification & Boundary Rejection", () => {
    it("accepts valid strict IPv4 dotted quads and rejects non-canonical or bypass encodings", () => {
      // Valid dotted-quads
      expect(isStrictIpv4("1.1.1.1")).toBe(true);
      expect(isStrictIpv4("192.168.1.1")).toBe(true);
      expect(isStrictIpv4("255.255.255.255")).toBe(true);

      // Non-canonical representations intended to bypass regex/filters
      expect(isStrictIpv4("0177.0.0.1")).toBe(false); // leading zero / octal
      expect(isStrictIpv4("127.0.0.01")).toBe(false); // leading zero
      expect(isStrictIpv4("0x7f000001")).toBe(false); // hex
      expect(isStrictIpv4("2130706433")).toBe(false); // integer
      expect(isStrictIpv4("127.1")).toBe(false); // short form
      expect(isStrictIpv4("1.2.3.4.5")).toBe(false); // 5 octets
      expect(isStrictIpv4("256.1.1.1")).toBe(false); // octet > 255
      expect(isStrictIpv4("")).toBe(false);
      expect(isStrictIpv4("127.0.0.1.com")).toBe(false);
    });

    it("identifies private, loopback, link-local, CGNAT, multicast, and reserved IPv4 ranges", () => {
      // Loopback (127.0.0.0/8)
      expect(isPublicIpv4("127.0.0.1")).toBe(false);
      expect(isPublicIpv4("127.255.255.254")).toBe(false);

      // RFC 1918 Private (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16)
      expect(isPublicIpv4("10.0.0.1")).toBe(false);
      expect(isPublicIpv4("10.254.254.254")).toBe(false);
      expect(isPublicIpv4("172.16.0.1")).toBe(false);
      expect(isPublicIpv4("172.31.255.255")).toBe(false);
      expect(isPublicIpv4("172.15.255.255")).toBe(true); // adjacent public
      expect(isPublicIpv4("172.32.0.1")).toBe(true); // adjacent public
      expect(isPublicIpv4("192.168.0.1")).toBe(false);
      expect(isPublicIpv4("192.168.255.254")).toBe(false);

      // Cloud Metadata & Link-Local (169.254.0.0/16)
      expect(isPublicIpv4("169.254.169.254")).toBe(false);
      expect(isPublicIpv4("169.254.1.1")).toBe(false);

      // Current Network (0.0.0.0/8)
      expect(isPublicIpv4("0.0.0.0")).toBe(false);
      expect(isPublicIpv4("0.1.2.3")).toBe(false);

      // CGNAT Shared Address Space (100.64.0.0/10)
      expect(isPublicIpv4("100.64.0.1")).toBe(false);
      expect(isPublicIpv4("100.127.255.255")).toBe(false);
      expect(isPublicIpv4("100.63.255.255")).toBe(true); // adjacent public
      expect(isPublicIpv4("100.128.0.1")).toBe(true); // adjacent public

      // Documentation & Test Nets (RFC 5737: 192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24)
      expect(isPublicIpv4("192.0.2.1")).toBe(false);
      expect(isPublicIpv4("198.51.100.1")).toBe(false);
      expect(isPublicIpv4("203.0.113.1")).toBe(false);

      // IANA Special & 6to4 Relay Anycast (192.0.0.0/24, 192.88.99.0/24)
      expect(isPublicIpv4("192.0.0.1")).toBe(false);
      expect(isPublicIpv4("192.88.99.1")).toBe(false);

      // Benchmarking (198.18.0.0/15)
      expect(isPublicIpv4("198.18.0.1")).toBe(false);
      expect(isPublicIpv4("198.19.255.255")).toBe(false);

      // Multicast & Reserved (224.0.0.0/4 and above)
      expect(isPublicIpv4("224.0.0.1")).toBe(false);
      expect(isPublicIpv4("240.0.0.1")).toBe(false);
      expect(isPublicIpv4("255.255.255.255")).toBe(false);

      // Legitimate Public IPv4
      expect(isPublicIpv4("8.8.8.8")).toBe(true);
      expect(isPublicIpv4("1.1.1.1")).toBe(true);
      expect(isPublicIpv4("93.184.216.34")).toBe(true);
    });
  });

  describe("IPv6 Normalization & Security Filtering", () => {
    it("normalizes IPv6 literals across standard, compressed, and IPv4-mapped forms", () => {
      expect(normalizeIpv6("::1")).toBe("0000:0000:0000:0000:0000:0000:0000:0001");
      expect(normalizeIpv6("fe80::1")).toBe("fe80:0000:0000:0000:0000:0000:0000:0001");
      expect(normalizeIpv6("::ffff:192.168.1.1")).toBe("0000:0000:0000:0000:0000:ffff:c0a8:0101");
      expect(normalizeIpv6("invalid:ipv6:address")).toBeNull();
      expect(normalizeIpv6("1::2::3")).toBeNull(); // multiple compression runs
    });

    it("rejects private, loopback, ULA, link-local, site-local, and documentation IPv6", () => {
      // Loopback (::1) and Unspecified (::)
      expect(isPublicIpAddress("::1")).toBe(false);
      expect(isPublicIpAddress("::")).toBe(false);
      expect(isPublicIpAddress("0:0:0:0:0:0:0:1")).toBe(false);

      // Unique Local Address ULA (fc00::/7)
      expect(isPublicIpAddress("fc00::1")).toBe(false);
      expect(isPublicIpAddress("fd12:3456:789a::1")).toBe(false);

      // Link-Local (fe80::/10) & Site-Local (fec0::/10)
      expect(isPublicIpAddress("fe80::1")).toBe(false);
      expect(isPublicIpAddress("fe80::dead:beef")).toBe(false);
      expect(isPublicIpAddress("fec0::1")).toBe(false);

      // Multicast (ff00::/8)
      expect(isPublicIpAddress("ff02::1")).toBe(false);

      // Documentation (2001:db8::/32) & Teredo (2001::/32)
      expect(isPublicIpAddress("2001:db8::1")).toBe(false);
      expect(isPublicIpAddress("2001:0000::1")).toBe(false);

      // NAT64 prefix (64:ff9b::/96)
      expect(isPublicIpAddress("64:ff9b::127.0.0.1")).toBe(false);

      // 6to4 prefix (2002::/16) with embedded private IPv4
      expect(isPublicIpAddress("2002:7f00:0001::")).toBe(false); // embedded 127.0.0.1
      expect(isPublicIpAddress("2002:0a00:0001::")).toBe(false); // embedded 10.0.0.1

      // IPv4-mapped IPv6 literals with private embedded addresses
      expect(isPublicIpAddress("::ffff:127.0.0.1")).toBe(false);
      expect(isPublicIpAddress("::ffff:169.254.169.254")).toBe(false);
      expect(isPublicIpAddress("::ffff:10.0.0.1")).toBe(false);
      expect(isPublicIpAddress("::ffff:192.168.1.1")).toBe(false);
      expect(isPublicIpAddress("::ffff:8.8.8.8")).toBe(true); // public IPv4 mapped

      // IPv4-compatible IPv6 literals (deprecated RFC 4291)
      expect(isPublicIpAddress("::127.0.0.1")).toBe(false);
      expect(isPublicIpAddress("::169.254.169.254")).toBe(false);
      expect(isPublicIpAddress("::10.0.0.1")).toBe(false);

      // Public Global Unicast IPv6
      expect(isPublicIpAddress("2606:4700:4700::1111")).toBe(true); // Cloudflare DNS
      expect(isPublicIpAddress("2001:4860:4860::8888")).toBe(true); // Google DNS
    });
  });

  describe("Hostname and Browser URL Sanitization", () => {
    it("flags suspicious hostnames and intranet names", () => {
      expect(isSuspiciousHostname("localhost")).toBe(true);
      expect(isSuspiciousHostname("localhost.localdomain")).toBe(true);
      expect(isSuspiciousHostname("ip6-localhost")).toBe(true);
      expect(isSuspiciousHostname("printer.local")).toBe(true);
      expect(isSuspiciousHostname("service.internal")).toBe(true);
      expect(isSuspiciousHostname("router.lan")).toBe(true);
      expect(isSuspiciousHostname("myhome.home")).toBe(true);
      expect(isSuspiciousHostname("host.arpa")).toBe(true);
      expect(isSuspiciousHostname("intranet")).toBe(true); // dotless hostname
      expect(isSuspiciousHostname("nas")).toBe(true); // dotless hostname
      expect(isSuspiciousHostname("2130706433")).toBe(true); // decimal IP evasion
      expect(isSuspiciousHostname("127.0.0.01")).toBe(true); // octal IP evasion

      // Canonicalization of trailing dots
      expect(isSuspiciousHostname("localhost.")).toBe(true);
      expect(isSuspiciousHostname("printer.local.")).toBe(true);

      // Legitimate public domain names
      expect(isSuspiciousHostname("example.com")).toBe(false);
      expect(isSuspiciousHostname("sub.domain.org")).toBe(false);
      expect(isSuspiciousHostname("cdn.orbmeet.com")).toBe(false);
    });

    it("evaluates isPublicBrowserHost against IPs, bracketed IPv6, and domains", () => {
      expect(isPublicBrowserHost("127.0.0.1")).toBe(false);
      expect(isPublicBrowserHost("127.0.0.1..")).toBe(false);
      expect(isPublicBrowserHost("[::1]")).toBe(false);
      expect(isPublicBrowserHost("169.254.169.254")).toBe(false);
      expect(isPublicBrowserHost("localhost")).toBe(false);
      expect(isPublicBrowserHost("printer.local")).toBe(false);
      expect(isPublicBrowserHost("10.0.0.1")).toBe(false);
      expect(isPublicBrowserHost("example.com")).toBe(true);
      expect(isPublicBrowserHost("1.1.1.1")).toBe(true);
      expect(isPublicBrowserHost("[2606:4700:4700::1111]")).toBe(true);
    });

    it("verifies isSafeExternalBrowserUrl comprehensively for client bookmark and asset URLs", () => {
      // Safe HTTPS URLs
      expect(isSafeExternalBrowserUrl("https://example.com")).toBe(true);
      expect(isSafeExternalBrowserUrl("https://example.com/path/to/resource?q=1#hash")).toBe(true);
      expect(isSafeExternalBrowserUrl("http://cdn.example.org:80/img.png")).toBe(true);

      // Prohibited schemes
      expect(isSafeExternalBrowserUrl("javascript:alert(1)")).toBe(false);
      expect(isSafeExternalBrowserUrl("data:text/html,<script>alert(1)</script>")).toBe(false);
      expect(isSafeExternalBrowserUrl("blob:https://example.com/uuid")).toBe(false);
      expect(isSafeExternalBrowserUrl("file:///etc/passwd")).toBe(false);
      expect(isSafeExternalBrowserUrl("ftp://example.com/file")).toBe(false);

      // Prohibited SSRF / Private hosts
      expect(isSafeExternalBrowserUrl("http://127.0.0.1/admin")).toBe(false);
      expect(isSafeExternalBrowserUrl("http://localhost:3000/status")).toBe(false);
      expect(isSafeExternalBrowserUrl("http://169.254.169.254/latest/meta-data/")).toBe(false);
      expect(isSafeExternalBrowserUrl("http://[::1]:8080/")).toBe(false);
      expect(isSafeExternalBrowserUrl("http://[::ffff:127.0.0.1]/secret")).toBe(false);
      expect(isSafeExternalBrowserUrl("http://10.0.0.1/internal")).toBe(false);
      expect(isSafeExternalBrowserUrl("http://192.168.1.1/router")).toBe(false);
      expect(isSafeExternalBrowserUrl("http://printer.local/jobs")).toBe(false);

      // Malformed or oversized URLs
      expect(isSafeExternalBrowserUrl("")).toBe(false);
      expect(isSafeExternalBrowserUrl(null)).toBe(false);
      expect(isSafeExternalBrowserUrl(123)).toBe(false);
      expect(isSafeExternalBrowserUrl("https://" + "a".repeat(3000) + ".com")).toBe(false);
    });
  });

  describe("Room ID Validation & Snapshot Schema", () => {
    it("enforces meeting room ID format constraints", () => {
      expect(isWhiteboardRoomId("meet-abc123")).toBe(true);
      expect(isWhiteboardRoomId("meet-valid_room-456")).toBe(true);
      expect(isWhiteboardRoomId("not-a-meet-room")).toBe(false);
      expect(isWhiteboardRoomId("../traversal")).toBe(false);
      expect(isWhiteboardRoomId("")).toBe(false);
      expect(toWhiteboardRoomId("test-1")).toBe("meet-test-1");
    });

    it("validates room snapshot records against schema", () => {
      const valid = createEmptyWhiteboardRoomSnapshot();
      expect(validateWhiteboardRoomSnapshot(valid).ok).toBe(true);

      const invalidSchema = {
        schema: { schemaVersion: 999 },
        documentClock: 1,
        documents: [],
      };
      expect(validateWhiteboardRoomSnapshot(invalidSchema).ok).toBe(false);

      const missingClock = {
        schema: whiteboardTLSchema.serialize(),
        documents: [],
      };
      expect(validateWhiteboardRoomSnapshot(missingClock).ok).toBe(false);
    });
  });
});
