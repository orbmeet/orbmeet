import { describe, expect, it } from "vitest";
import {
  isPublicBrowserHost,
  isPublicIpAddress,
  isSafeExternalBrowserUrl,
} from "@orbmeet/whiteboard-core/public-host";
import {
  classifyIncomingDiff,
  JsonMessageAssembler,
} from "./rooms/page-frame-guard.ts";

describe("CRDT guard and SSRF filter hardening", () => {
  describe("whiteboard CRDT guards and RoomMessageGuard", () => {
    const pageFrameIds = new Set(["shape:page-1"]);

    it("rejects malformed diff operations and non-object inputs", () => {
      expect(classifyIncomingDiff(null, pageFrameIds)).toBe("allow");
      expect(classifyIncomingDiff({ type: "push", diff: null }, pageFrameIds)).toBe("allow");
      expect(classifyIncomingDiff({ type: "push", diff: { "shape:1": "invalid-str" } }, pageFrameIds)).toBe("forbidden");
      expect(classifyIncomingDiff({ type: "push", diff: { "shape:1": 999 } }, pageFrameIds)).toBe("forbidden");
      expect(classifyIncomingDiff({ type: "push", diff: { "shape:1": [] } }, pageFrameIds)).toBe("forbidden");
      expect(classifyIncomingDiff({ type: "push", diff: { "shape:1": ["bad_op", {}] } }, pageFrameIds)).toBe("forbidden");
      expect(classifyIncomingDiff({ type: "push", diff: { "page:1": ["put"] } }, pageFrameIds)).toBe("forbidden");
    });

    it("resists prototype pollution across diff and patch payloads", () => {
      const payloads = [
        { type: "push", diff: { "__proto__": ["put", { polluted: true }] } },
        { type: "push", diff: { "shape:1": ["patch", { "__proto__": { polluted: true } }] } },
        { type: "push", diff: { "shape:1": ["patch", { "constructor": { "prototype": { polluted: true } } }] } },
        { type: "push", diff: { "shape:1": ["patch", { props: ["patch", { "__proto__": { polluted: true } }] }] } },
      ];
      for (const payload of payloads) {
        classifyIncomingDiff(payload, pageFrameIds);
        expect(({} as any).polluted).toBeUndefined();
      }
    });

    // Native page and document records, shape subtype changes and page-frame
    // geometry are judged per record after tldraw applies a push: see
    // rooms/room-record-authorizers.room.test.ts.

    it("enforces chunk assembly limits and rejects out-of-order chunks", () => {
      const asm = new JsonMessageAssembler();
      expect(asm.handleMessage("5000_chunk")).toHaveProperty("error");
      expect(asm.handleMessage("-1_chunk")).toHaveProperty("error");
      expect(asm.handleMessage("not_a_chunk")).toHaveProperty("error");

      const asm2 = new JsonMessageAssembler();
      asm2.handleMessage('2_{"a":');
      expect(asm2.handleMessage('0,"b"}')).toHaveProperty("error"); // out of order
    });
  });

  describe("SSRF filters and alternative IP representations", () => {
    it("blocks dotless and mixed hex, octal, dword and short-form IPv4 representations", () => {
      const badIps = [
        "0x7f000001", "0x7f.0.0.1", "0xa9fea9fe", "0x0a000001", "0177.0.0.1", "017700000001",
        "2130706433", "2852039166", "0", "127.1", "10.1", "127.0.0.01",
      ];
      for (const ip of badIps) {
        expect(isPublicIpAddress(ip)).toBe(false);
        expect(isPublicBrowserHost(ip)).toBe(false);
      }
    });

    it("blocks multi-part hex IPv4 loopback/metadata URLs in isSafeExternalBrowserUrl", () => {
      const hexUrls = ["http://0x7f.0x0.0x0.0x1", "http://0xa9.0xfe.0xa9.0xfe", "http://0x0a.0x00.0x00.0x01"];
      for (const url of hexUrls) {
        expect(isSafeExternalBrowserUrl(url)).toBe(false);
      }
    });

    it("blocks trailing dot evasion and suspicious intranet hostnames", () => {
      expect(isPublicBrowserHost("127.0.0.1.")).toBe(false);
      expect(isPublicBrowserHost("127.0.0.1..")).toBe(false);
      expect(isPublicBrowserHost("localhost.")).toBe(false);
      expect(isPublicBrowserHost("localhost")).toBe(false);
      expect(isPublicBrowserHost("intranet")).toBe(false);
      expect(isPublicBrowserHost("service.local")).toBe(false);
      expect(isPublicBrowserHost("corp.internal")).toBe(false);
      expect(isPublicBrowserHost("example.com.")).toBe(true);
    });

    it("blocks IPv4-mapped, IPv4-compatible, and 6to4 private IPv6 ranges", () => {
      const badIpv6 = [
        "::ffff:127.0.0.1", "::ffff:169.254.169.254", "::ffff:7f00:1", "::127.0.0.1", "::7f00:1",
        "2002:7f00:0001::", "2002:a9fe:a9fe::", "fc00::1", "fe80::1", "ff02::1", "2001:db8::1",
      ];
      for (const ip of badIpv6) {
        expect(isPublicIpAddress(ip)).toBe(false);
        expect(isPublicBrowserHost(ip)).toBe(false);
      }
      expect(isPublicIpAddress("2002:0808:0808::")).toBe(true); // public 8.8.8.8 embedded
    });

    it("validates external browser URL safety", () => {
      expect(isSafeExternalBrowserUrl("https://example.com/asset.png")).toBe(true);
      expect(isSafeExternalBrowserUrl("http://127.0.0.1/admin")).toBe(false);
      expect(isSafeExternalBrowserUrl("javascript:alert(1)")).toBe(false);
      expect(isSafeExternalBrowserUrl("file:///etc/passwd")).toBe(false);
      expect(isSafeExternalBrowserUrl("http://169.254.169.254/latest")).toBe(false);
    });
  });
});
