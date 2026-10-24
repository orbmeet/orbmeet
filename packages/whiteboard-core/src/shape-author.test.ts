import { describe, expect, it } from "vitest";
import {
  hasShapeAuthor,
  MAX_SHAPE_AUTHOR_NAME_LENGTH,
  readShapeAuthor,
  shapeAuthorOf,
  withShapeAuthor,
} from "./shape-author.ts";
import { isPdfPageShapeId, pdfPageAssetName, pdfPageShapeKey } from "./pdf-page-asset.ts";

const MAYA = { id: "user-maya", name: "Maya" };

describe("shape author", () => {
  it("reads a well-formed author and refuses anything else", () => {
    expect(readShapeAuthor({ createdBy: MAYA })).toEqual(MAYA);
    expect(readShapeAuthor({})).toBeNull();
    expect(readShapeAuthor(null)).toBeNull();
    expect(readShapeAuthor({ createdBy: "Maya" })).toBeNull();
    expect(readShapeAuthor({ createdBy: { id: "", name: "Maya" } })).toBeNull();
    expect(readShapeAuthor({ createdBy: { id: "u", name: 4 } })).toBeNull();
  });

  it("matches only the exact record, with no extra keys", () => {
    expect(hasShapeAuthor({ createdBy: MAYA }, MAYA)).toBe(true);
    expect(hasShapeAuthor({ createdBy: { ...MAYA, admin: true } }, MAYA)).toBe(false);
    expect(hasShapeAuthor({ createdBy: { id: "user-maya", name: "M" } }, MAYA)).toBe(false);
    expect(hasShapeAuthor({}, null)).toBe(true);
    expect(hasShapeAuthor({ createdBy: null }, null)).toBe(false);
  });

  it("sets and clears the author without touching the rest of meta", () => {
    expect(withShapeAuthor({ note: "x" }, MAYA)).toEqual({ note: "x", createdBy: MAYA });
    expect(withShapeAuthor({ note: "x", createdBy: MAYA }, null)).toEqual({ note: "x" });
  });

  it("bounds a session's name like the room does", () => {
    expect(shapeAuthorOf("u", "n".repeat(400)).name).toHaveLength(MAX_SHAPE_AUTHOR_NAME_LENGTH);
  });
});

describe("pdf page asset naming", () => {
  it("names a page's image by its place in the import", () => {
    expect(pdfPageAssetName("pdf-import-abc.pdf", 2)).toBe("pdf-import-abc.pdf-page-3.png");
  });

  it("recognises the shape ids the importer places", () => {
    expect(isPdfPageShapeId(`shape:${pdfPageShapeKey("abc", 0)}`)).toBe(true);
    expect(isPdfPageShapeId("shape:abc")).toBe(false);
  });
});
