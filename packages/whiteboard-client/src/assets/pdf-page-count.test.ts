import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { countPdfPages } from "./pdf-page-count";

describe("countPdfPages", () => {
  it("counts a PDF's pages", async () => {
    const document = await PDFDocument.create();
    for (let i = 0; i < 3; i += 1) document.addPage();
    const file = new File([new Uint8Array(await document.save())], "deck.pdf", { type: "application/pdf" });
    expect(await countPdfPages(file)).toBe(3);
  });

  it("gives up on something that is not a PDF", async () => {
    expect(await countPdfPages(new File(["hello"], "notes.pdf"))).toBeNull();
  });
});
