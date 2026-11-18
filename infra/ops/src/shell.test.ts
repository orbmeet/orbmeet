import { describe, expect, it } from "vitest";
import { shell } from "./shell.ts";

describe("shell", () => {
  it("captures a character written across two chunks whole", async () => {
    // "é" is two bytes; the child writes them apart, with a pause between.
    const script = "process.stdout.write(Buffer.from([0xc3])); setTimeout(() => process.stdout.write(Buffer.from([0xa9])), 50);";
    await expect(shell([process.execPath, "-e", script], { capture: true })).resolves.toBe("é");
  });
});
