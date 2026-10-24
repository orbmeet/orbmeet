import { describe, expect, it, vi } from "vitest";
import {
  validateCustomRtmpUrl,
  validatePublicRtmpDestination,
  type RtmpHostnameResolver,
} from "./rtmp-destination.server";

describe("validateCustomRtmpUrl", () => {
  it("accepts public RTMPS URLs without embedded credentials", () => {
    expect(validateCustomRtmpUrl("rtmps://stream.example.com/app/live_123")).toBe(
      "rtmps://stream.example.com/app/live_123",
    );
  });

  it.each([
    "rtmp://stream.example.com/app/live_123",
    "rtmps://user:pass@stream.example.com/app/live_123",
    "rtmps://localhost/app/live_123",
    "rtmps://camera.local/app/live_123",
    "rtmps://127.0.0.1/app/live_123",
    "rtmps://2130706433/app/live_123",
    "rtmps://0x7f000001/app/live_123",
    "rtmps://0177.0.0.1/app/live_123",
    "rtmps://10.0.0.8/app/live_123",
    "rtmps://192.168.1.10/app/live_123",
    "rtmps://169.254.169.254/app/live_123",
    "rtmps://192.0.2.1/app/live_123",
    "rtmps://198.51.100.1/app/live_123",
    "rtmps://203.0.113.1/app/live_123",
    "rtmps://[::1]/app/live_123",
    "rtmps://[fd00::1]/app/live_123",
    "rtmps://[::ffff:127.0.0.1]/app/live_123",
    // IPv6 literals skip DNS resolution entirely, so this filter is the only
    // check standing in front of them.
    "rtmps://[::]/app/live_123",
    "rtmps://[0:0:0:0:0:0:0:1]/app/live_123",
    "rtmps://[::127.0.0.1]/app/live_123", // IPv4-compatible (normalizes to ::7f00:1)
    "rtmps://[::7f00:1]/app/live_123",
    "rtmps://[::ffff:169.254.169.254]/app/live_123",
    "rtmps://[fc00::1]/app/live_123",
    "rtmps://[fe80::1]/app/live_123",
    "rtmps://[febf::1]/app/live_123",
    "rtmps://[fec0::1]/app/live_123", // site-local
    "rtmps://[feff::1]/app/live_123",
    "rtmps://[ff02::1]/app/live_123", // multicast
    "rtmps://[64:ff9b::7f00:1]/app/live_123", // NAT64
    "rtmps://[2002:7f00:1::]/app/live_123", // 6to4 wrapping 127.0.0.1
    "rtmps://[2001:db8::1]/app/live_123",
    "rtmps://[100::1]/app/live_123", // discard-only
  ])("rejects unsafe destination %s", (url) => {
    expect(() => validateCustomRtmpUrl(url)).toThrow();
  });

  it.each([
    "rtmps://[2606:4700:4700::1111]/app/live_123",
    "rtmps://[2a00:1450:4001:80f::200e]/app/live_123",
  ])("accepts public IPv6 destination %s", (url) => {
    expect(() => validateCustomRtmpUrl(url)).not.toThrow();
  });
});

describe("validatePublicRtmpDestination", () => {
  it("accepts DNS hosts that resolve only to public addresses", async () => {
    const resolver: RtmpHostnameResolver = vi.fn().mockResolvedValue([
      { address: "203.0.114.10", family: 4 },
      { address: "2606:4700:4700::1111", family: 6 },
    ]);

    await expect(
      validatePublicRtmpDestination("rtmps://stream.example.com/app/live_123", resolver),
    ).resolves.toBe("rtmps://stream.example.com/app/live_123");
    expect(resolver).toHaveBeenCalledWith("stream.example.com");
  });

  it("rejects DNS hosts that resolve to private addresses", async () => {
    const resolver: RtmpHostnameResolver = vi.fn().mockResolvedValue([
      { address: "198.51.101.20", family: 4 },
      { address: "10.0.0.8", family: 4 },
    ]);

    await expect(
      validatePublicRtmpDestination("rtmps://stream.example.com/app/live_123", resolver),
    ).rejects.toThrow();
  });

  it("rejects DNS hosts that do not resolve", async () => {
    const resolver: RtmpHostnameResolver = vi.fn().mockResolvedValue([]);

    await expect(
      validatePublicRtmpDestination("rtmps://stream.example.com/app/live_123", resolver),
    ).rejects.toThrow();
  });
});
