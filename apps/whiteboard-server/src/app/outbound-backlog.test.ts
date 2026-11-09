import { describe, expect, it } from "vitest";
import { OutboundBacklog, SHED_MIN_BUFFERED_BYTES } from "./outbound-backlog.ts";

const MB = 1024 * 1024;

describe("OutboundBacklog", () => {
  it("leaves sockets alone while the node is within budget", () => {
    const backlog = new OutboundBacklog(() => [{ bufferedAmount: 50 * MB }], 100 * MB, () => 0);
    expect(backlog.shouldShed(50 * MB)).toBe(false);
  });

  it("sheds sockets that are behind once the node is over budget", () => {
    const backlog = new OutboundBacklog(() => Array(3).fill({ bufferedAmount: 50 * MB }), 100 * MB, () => 0);
    expect(backlog.shouldShed(50 * MB)).toBe(true);
  });

  it("never sheds a socket that is keeping up", () => {
    const backlog = new OutboundBacklog(() => Array(3).fill({ bufferedAmount: 50 * MB }), 100 * MB, () => 0);
    expect(backlog.shouldShed(SHED_MIN_BUFFERED_BYTES - 1)).toBe(false);
  });

  it("stops shedding when dropped sockets bring the node back within budget", () => {
    const backlog = new OutboundBacklog(() => Array(3).fill({ bufferedAmount: 50 * MB }), 100 * MB, () => 0);
    expect(backlog.shouldShed(50 * MB)).toBe(true);
    backlog.release(50 * MB);
    expect(backlog.shouldShed(50 * MB)).toBe(false);
  });

  it("does not sum every socket on every send", () => {
    let reads = 0;
    let time = 0;
    const sockets = [{ get bufferedAmount() { reads += 1; return 50 * MB; } }];
    const backlog = new OutboundBacklog(() => sockets, 100 * MB, () => time);
    backlog.shouldShed(50 * MB);
    backlog.shouldShed(50 * MB);
    expect(reads).toBe(1);
    time = 1_000;
    backlog.shouldShed(50 * MB);
    expect(reads).toBe(2);
  });
});
