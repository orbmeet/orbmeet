import { describe, it, expect } from "vitest";
import { parseImportPlacement, parsePdfImportPath } from "./pdf-import-contract.ts";

const JOB = "0123abcd-89ab-cdef-0123-456789abcdef";

describe("parsePdfImportPath", () => {
  it("parses the start route and an import's own route", () => {
    expect(parsePdfImportPath("/pdf-import")).toEqual({ type: "start" });
    expect(parsePdfImportPath(`/pdf-import/${JOB}`)).toEqual({ type: "job", id: JOB });
  });

  it("rejects unknown and malformed routes", () => {
    expect(parsePdfImportPath("/pdf-import/not-a-uuid")).toBeNull();
    expect(parsePdfImportPath(`/pdf-import/${JOB}/commit`)).toBeNull();
    expect(parsePdfImportPath("/pdf-render")).toBeNull();
    expect(parsePdfImportPath("/other")).toBeNull();
  });
});

describe("parseImportPlacement", () => {
  const placement = (query: string) => parseImportPlacement(new URL(`https://wb.test/pdf-import?${query}`));

  it("reads where the pages go", () => {
    expect(placement("insertIndex=2")).toEqual({ insertIndex: 2 });
    expect(placement("insertIndex=0&reuseFrameId=shape:page-1&maxPages=4")).toEqual({
      insertIndex: 0,
      reuseFrameId: "shape:page-1",
      maxPages: 4,
    });
  });

  it("refuses a placement it cannot trust", () => {
    expect(placement("")).toBeNull();
    expect(placement("insertIndex=-1")).toBeNull();
    expect(placement("insertIndex=1.5")).toBeNull();
    expect(placement("insertIndex=0&reuseFrameId=page-1")).toBeNull();
    expect(placement("insertIndex=0&maxPages=0")).toBeNull();
    expect(placement("insertIndex=0&maxPages=101")).toBeNull();
  });
});
