import { describe, expect, it } from "vitest";
import { pdfScratchReservationFits } from "./pdf-import-jobs.ts";

const MIB = 1024 * 1024;

describe("PDF scratch capacity admission", () => {
  it("accounts for both maximum accepted input and worst-case rendered output", () => {
    // Each admitted import reserves 50 MiB of input plus 256 MiB of output.
    expect(pdfScratchReservationFits(0)).toBe(true);
    expect(pdfScratchReservationFits(306 * MIB)).toBe(true);
    expect(pdfScratchReservationFits(612 * MIB)).toBe(false);
  });
});
