import { describe, expect, it } from "vitest";
import type { Editor, TLShape, TLShapeId } from "tldraw";
import { boardCacheKey, hashPageContent } from "./page-thumbnail-signature";

type FakeShape = Pick<TLShape, "id" | "type" | "x" | "y" | "rotation" | "opacity" | "index"> & {
  props: Record<string, unknown>;
};

function shape(id: string, props: Record<string, unknown> = {}): FakeShape {
  return {
    id: id as TLShapeId,
    type: "draw",
    x: 0,
    y: 0,
    rotation: 0,
    opacity: 1,
    index: "a1" as FakeShape["index"],
    props,
  };
}

/** Just enough editor for the hash: shapes and assets by id. */
function fakeEditor(
  shapes: FakeShape[],
  assets: Record<string, { src: string | null }> = {},
): Editor {
  const byId = new Map(shapes.map((s) => [String(s.id), s]));
  return {
    getShape: (id: unknown) => byId.get(String(id)),
    getAsset: (id: unknown) => {
      const asset = assets[String(id)];
      return asset ? { props: asset } : undefined;
    },
  } as unknown as Editor;
}

const PAGE = "shape:page-1" as TLShapeId;

describe("hashPageContent", () => {
  it("is stable for a page nobody has touched", () => {
    const editor = fakeEditor([shape("shape:page-1"), shape("shape:a")]);
    const ids = ["shape:a" as TLShapeId];
    expect(hashPageContent(editor, PAGE, ids)).toBe(hashPageContent(editor, PAGE, ids));
  });

  it("does not depend on the order shapes arrived in", () => {
    // Two clients learn about the same shapes over the wire in different
    // orders. A hash that disagreed would make each of them believe the
    // other's cached thumbnail was out of date, forever.
    const editor = fakeEditor([
      shape("shape:page-1"),
      shape("shape:a"),
      shape("shape:b"),
    ]);
    const forward = ["shape:a", "shape:b"] as TLShapeId[];
    const backward = ["shape:b", "shape:a"] as TLShapeId[];
    expect(hashPageContent(editor, PAGE, forward)).toBe(
      hashPageContent(editor, PAGE, backward),
    );
  });

  it("moves when a stroke moves", () => {
    const before = fakeEditor([shape("shape:page-1"), shape("shape:a")]);
    const moved = shape("shape:a");
    moved.y = 40;
    const after = fakeEditor([shape("shape:page-1"), moved]);
    const ids = ["shape:a" as TLShapeId];
    expect(hashPageContent(after, PAGE, ids)).not.toBe(
      hashPageContent(before, PAGE, ids),
    );
  });

  it("moves when a shape opacity changes", () => {
    const beforeShape = shape("shape:a");
    const afterShape = shape("shape:a");
    afterShape.opacity = 0.25;
    const ids = ["shape:a" as TLShapeId];
    expect(hashPageContent(fakeEditor([shape("shape:page-1"), beforeShape]), PAGE, ids)).not.toBe(
      hashPageContent(fakeEditor([shape("shape:page-1"), afterShape]), PAGE, ids),
    );
  });

  it("distinguishes an image whose asset has not resolved from one that has", () => {
    // The bug this exists to make impossible: an imported PDF page rasterises
    // blank while its asset is still loading. If the blank render hashed the
    // same as the loaded one, the cache would keep the blank picture and every
    // later session would trust it.
    const shapes = [shape("shape:page-1"), shape("shape:img", { assetId: "asset:1" })];
    const ids = ["shape:img" as TLShapeId];
    const pending = fakeEditor(shapes, { "asset:1": { src: null } });
    const resolved = fakeEditor(shapes, { "asset:1": { src: "https://cdn/x.png" } });
    expect(hashPageContent(pending, PAGE, ids)).not.toBe(
      hashPageContent(resolved, PAGE, ids),
    );
  });

  it("survives a shape that vanished mid-hash", () => {
    const editor = fakeEditor([shape("shape:page-1")]);
    expect(() =>
      hashPageContent(editor, PAGE, ["shape:gone" as TLShapeId]),
    ).not.toThrow();
  });
});

describe("boardCacheKey", () => {
  it("ignores the query string, where the token lives", () => {
    // A rotating token in the URL would give the same board a new cache every
    // session, which is the same as having no cache at all.
    expect(boardCacheKey("https://wb.example.com/room/abc?token=one", "wb_1")).toBe(
      boardCacheKey("https://wb.example.com/room/abc?token=two", "wb_1"),
    );
  });

  it("keeps two different boards apart", () => {
    expect(boardCacheKey("https://wb.example.com/room/abc", "wb_1")).not.toBe(
      boardCacheKey("https://wb.example.com/room/xyz", "wb_1"),
    );
  });

  it("is empty when there is no board to key on", () => {
    expect(boardCacheKey(undefined, "wb_1")).toBe("");
  });
});
