import { describe, expect, it } from "vitest";
import { stunAnswers, stunRequest, turnAllocate } from "./check.ts";

describe("STUN and TURN probes", () => {
  const transaction = Buffer.from("0123456789ab");

  it("send RFC 5389 messages", () => {
    expect(stunRequest(transaction).toString("hex")).toBe(`000100002112a442${transaction.toString("hex")}`);
    // Allocate, one REQUESTED-TRANSPORT attribute asking for UDP.
    expect(turnAllocate(transaction).toString("hex")).toBe(`000300082112a442${transaction.toString("hex")}0019000411000000`);
  });

  it("accept only the expected answer to their own transaction", () => {
    const answer = Buffer.concat([Buffer.from("010100002112a442", "hex"), transaction]);
    expect(stunAnswers(answer, 0x0101, transaction)).toBe(true);
    expect(stunAnswers(answer, 0x0113, transaction)).toBe(false);
    expect(stunAnswers(answer, 0x0101, Buffer.from("ba9876543210"))).toBe(false);
    expect(stunAnswers(answer.subarray(0, 12), 0x0101, transaction)).toBe(false);
  });
});
