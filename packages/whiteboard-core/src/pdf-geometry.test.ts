import { describe, expect, it } from "vitest";
import {
  estimatePdfImportReserveBytes,
  fitContained,
  isPdfSourceFileId,
  PDF_MAX_IMPORT_SIZE,
  PDF_SOURCE_FILE_ID_MAX_LENGTH,
} from "./pdf-geometry.ts";

describe("isPdfSourceFileId", () => {
  it("accepts non-empty ids through the shared protocol limit", () => {
    expect(isPdfSourceFileId("asset_123")).toBe(true);
    expect(isPdfSourceFileId("x".repeat(PDF_SOURCE_FILE_ID_MAX_LENGTH))).toBe(true);
  });

  it("rejects empty, oversized, and non-string values", () => {
    expect(isPdfSourceFileId("")).toBe(false);
    expect(isPdfSourceFileId("x".repeat(PDF_SOURCE_FILE_ID_MAX_LENGTH + 1))).toBe(false);
    expect(isPdfSourceFileId(null)).toBe(false);
  });
});

describe("estimatePdfImportReserveBytes", () => {
  it("reserves a floor for tiny PDFs instead of the full 50 MB cap", () => {
    const reserved = estimatePdfImportReserveBytes(100 * 1024); // 100 KB PDF
    expect(reserved).toBe(2 * 1024 * 1024); // floor
    expect(reserved).toBeLessThan(PDF_MAX_IMPORT_SIZE);
  });

  it("scales with the upload size for mid-size PDFs", () => {
    const reserved = estimatePdfImportReserveBytes(5 * 1024 * 1024); // 5 MB PDF
    expect(reserved).toBe(20 * 1024 * 1024); // 4×
  });

  it("never exceeds the hard import cap", () => {
    expect(estimatePdfImportReserveBytes(PDF_MAX_IMPORT_SIZE)).toBe(PDF_MAX_IMPORT_SIZE);
  });
});

describe("fitContained", () => {
  it("returns a centered empty fit for zero-sized input", () => {
    expect(fitContained(0, 100, 600, 400)).toEqual({
      x: 300,
      y: 200,
      width: 0,
      height: 0,
    });
  });
});
