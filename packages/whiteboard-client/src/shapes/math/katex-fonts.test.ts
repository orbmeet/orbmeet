import { describe, expect, it } from "vitest";
import { getKatexFontFaces } from "./katex-fonts";

const families = (latex: string) =>
  getKatexFontFaces(latex).map((face) => `${face.family} ${face.weight} ${face.style}`);

describe("getKatexFontFaces", () => {
  it("declares the faces every equation is set in", () => {
    expect(families("x^{2}")).toEqual(expect.arrayContaining([
      "KaTeX_Main 400 normal",
      "KaTeX_Math 400 italic",
      "KaTeX_AMS 400 normal",
      "KaTeX_Size1 400 normal",
      "KaTeX_Size4 400 normal",
    ]));
    expect(families("x^{2}")).not.toContain("KaTeX_Main 700 normal");
  });

  it("adds the faces that font commands reach", () => {
    expect(families("\\mathbf{v} + \\mathcal{L}")).toEqual(expect.arrayContaining([
      "KaTeX_Main 700 normal",
      "KaTeX_Caligraphic 400 normal",
    ]));
  });

  it("returns the same face objects every time, so tldraw tracks each face once", () => {
    expect(getKatexFontFaces("x")[0]).toBe(getKatexFontFaces("y")[0]);
  });
});
