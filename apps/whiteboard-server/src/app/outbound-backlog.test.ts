import { describe, expect, it } from "vitest";
import { OutboundBacklog, SHED_MIN_BUFFERED_BYTES } from "./outbound-backlog.ts";

const MB = 1024 * 1024;

const socket = (bufferedAmount: number) => ({ bufferedAmount });

describe("OutboundBacklog", () => {
  it("leaves sockets alone while the node is within budget", () => {
    const backlog = new OutboundBacklog(() => [socket(50 * MB)], 100 * MB, () => 0);
    expect(backlog.socketsToShed()).toEqual([]);
  });

  it("drops the sockets furthest behind, and only as many as the budget needs", () => {
    const small = socket(10 * MB);
    const middle = socket(30 * MB);
    const large = socket(90 * MB);
    const backlog = new OutboundBacklog(() => [small, large, middle], 100 * MB, () => 0);
    expect(backlog.socketsToShed()).toEqual([large]);
  });

  it("drops further sockets when the first is not enough", () => {
    const sockets = [socket(50 * MB), socket(50 * MB), socket(50 * MB), socket(50 * MB)];
    const backlog = new OutboundBacklog(() => sockets, 100 * MB, () => 0);
    expect(backlog.socketsToShed()).toHaveLength(2);
  });

  it("never drops a socket that is keeping up", () => {
    const keepingUp = socket(SHED_MIN_BUFFERED_BYTES - 1);
    const behind = socket(2 * MB);
    const backlog = new OutboundBacklog(() => [keepingUp, behind], MB, () => 0);
    expect(backlog.socketsToShed()).toEqual([behind]);
  });

  it("does not sum every socket on every send", () => {
    let reads = 0;
    let time = 0;
    const sockets = [{ get bufferedAmount() { reads += 1; return 50 * MB; } }];
    const backlog = new OutboundBacklog(() => sockets, 100 * MB, () => time);
    backlog.socketsToShed();
    backlog.socketsToShed();
    expect(reads).toBe(1);
    time = 1_000;
    backlog.socketsToShed();
    expect(reads).toBe(2);
  });
});
