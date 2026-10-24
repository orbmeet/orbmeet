import { describe, expect, it, vi } from "vitest";
import type { Editor, TLAsset, TLShape } from "tldraw";
import { describeShapeSource, type ShapeSourceLookups } from "./shape-source";
import { registerShapeAuthorStamp } from "../editor/shape-author-stamp";

const MAYA = { id: "user-maya", name: "Maya" };

function shape(type: string, extra: Partial<TLShape> = {}): TLShape {
  return { id: "shape:a", type, meta: {}, props: {}, ...extra } as unknown as TLShape;
}

function asset(name: string): TLAsset {
  return { id: "asset:a", type: "image", props: { name } } as unknown as TLAsset;
}

function lookups(overrides: Partial<ShapeSourceLookups> = {}): ShapeSourceLookups {
  return {
    getAsset: () => undefined,
    getParent: () => undefined,
    getLibraryFileName: () => undefined,
    ...overrides,
  };
}

const board = lookups();

describe("describeShapeSource", () => {
  it("names what someone typed, with its author", () => {
    expect(describeShapeSource(shape("text", { meta: { createdBy: MAYA } }), board)).toEqual({
      kind: "typed",
      label: "Text",
      author: MAYA,
    });
    expect(describeShapeSource(shape("math"), board)?.label).toBe("Math");
  });

  it("names pen and highlighter strokes as drawn", () => {
    expect(describeShapeSource(shape("draw"), board)).toMatchObject({ kind: "drawn", label: "Pen", author: null });
    expect(describeShapeSource(shape("highlight"), board)?.label).toBe("Highlighter");
  });

  describe("an imported PDF page", () => {
    const page = shape("image", {
      id: "shape:pdf-page-imp1-0" as TLShape["id"],
      parentId: "shape:frame" as TLShape["parentId"],
      meta: { createdBy: MAYA },
    });
    const filedFrame = () => ({ meta: { sourceFileId: "file_lecture", sourcePageNumber: 5 } });

    it("is named by its Space file and real page", () => {
      const named = lookups({ getParent: filedFrame, getLibraryFileName: () => "lecture-4.pdf" });
      expect(describeShapeSource(page, named)).toEqual({
        kind: "imported",
        label: "lecture-4.pdf · page 5",
        author: MAYA,
      });
    });

    it("keeps the real page when the library can't be read", () => {
      expect(describeShapeSource(page, lookups({ getParent: filedFrame }))?.label).toBe("PDF · page 5");
    });

    it("claims no page number for a PDF uploaded straight from a device", () => {
      // Its stored name counts from the start of the import, so a partial import would read wrong.
      const uploaded = lookups({ getParent: () => ({ meta: {} }), getAsset: () => asset("pdf-import-imp1.pdf-page-1.png") });
      expect(describeShapeSource(page, uploaded)?.label).toBe("Imported PDF");
    });
  });

  it("names an image by its file name", () => {
    const photo = shape("image", { props: { assetId: "asset:a" } });
    expect(describeShapeSource(photo, lookups({ getAsset: () => asset("whiteboard.jpg") }))?.label).toBe(
      "Image · whiteboard.jpg",
    );
    expect(describeShapeSource(photo, board)?.label).toBe("Image");
  });

  it("skips the board's own structure", () => {
    expect(describeShapeSource(shape("whiteboard-page"), board)).toBeNull();
    expect(describeShapeSource(shape("group"), board)).toBeNull();
  });

  it("falls back to a placed shape for anything else", () => {
    expect(describeShapeSource(shape("arrow"), board)).toMatchObject({ kind: "placed", label: "Arrow" });
    expect(describeShapeSource(shape("something-new"), board)?.label).toBe("Shape");
  });
});

describe("registerShapeAuthorStamp", () => {
  function stampWith() {
    let handler: ((shape: TLShape, source: "user" | "remote") => TLShape) | undefined;
    const editor = {
      sideEffects: {
        registerBeforeCreateHandler: (_type: string, next: typeof handler) => {
          handler = next;
          return vi.fn();
        },
      },
    } as unknown as Editor;
    registerShapeAuthorStamp(editor, MAYA);
    return handler!;
  }

  it("stamps what this user creates, replacing a copied author", () => {
    const stamp = stampWith();
    expect(stamp(shape("text", { meta: { note: "x" } }), "user").meta).toEqual({ note: "x", createdBy: MAYA });
    expect(stamp(shape("text", { meta: { createdBy: { id: "jo", name: "Jo" } } }), "user").meta).toEqual({
      createdBy: MAYA,
    });
  });

  it("leaves shapes from the room as the room settled them", () => {
    const stamp = stampWith();
    const remote = shape("text", { meta: { createdBy: { id: "jo", name: "Jo" } } });
    expect(stamp(remote, "remote")).toBe(remote);
  });
});
