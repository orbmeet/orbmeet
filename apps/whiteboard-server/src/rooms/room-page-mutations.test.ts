import { describe, expect, it } from "vitest";
import { getIndexAbove, type IndexKey } from "@tldraw/utils";
import type { TLRecord } from "@tldraw/tlschema";
import {
  insertImportedPagesInTransaction,
  PdfImportAnchorMissingError,
  PdfImportPartiallyAppliedError,
  PdfImportPlacementAbortedError,
} from "./room-page-mutations.ts";
import { WHITEBOARD_CONFIG } from "@orbmeet/whiteboard-core/config";
import { WHITEBOARD_PAGE_SHAPE_TYPE } from "@orbmeet/whiteboard-core/page-shape-schema";

function pageFrame(index: number, indexKey: IndexKey): TLRecord {
  return {
    id: `shape:page-${index}`,
    typeName: "shape",
    type: WHITEBOARD_PAGE_SHAPE_TYPE,
    parentId: "page:page",
    index: indexKey,
    x: 0,
    y: index * 940,
    rotation: 0,
    isLocked: false,
    opacity: 1,
    props: {
      w: 1200,
      h: 900,
      name: `Page ${index + 1}`,
      background: "white",
    },
    meta: {},
  } as TLRecord;
}

describe("insertImportedPagesInTransaction", () => {
  it("throws after a concurrent page-limit conflict so SQLite rolls back reuse mutations", () => {
    const records = new Map<string, TLRecord>();
    records.set("page:page", {
      id: "page:page",
      typeName: "page",
      name: "Page 1",
      index: "a1",
      meta: {},
    } as TLRecord);
    let indexKey: IndexKey | undefined;
    for (let index = 0; index < WHITEBOARD_CONFIG.MAX_PAGES; index += 1) {
      indexKey = getIndexAbove(indexKey);
      const frame = pageFrame(index, indexKey);
      records.set(frame.id, frame);
    }
    const originalHeight = (records.get("shape:page-0") as { props: { h: number } }).props.h;
    const transaction = {
      values: () => records.values(),
      set: (id: TLRecord["id"], record: TLRecord) => records.set(id, record),
    };

    expect(() => insertImportedPagesInTransaction(transaction, {
      importId: "00000000-0000-4000-8000-000000000001",
      insertIndex: 1,
      reuse: { frameId: "shape:page-0", height: 600 },
      pages: [
        {
          pageIndex: 0,
          r2Key: "whiteboards/whiteboard_1/assets/imports/id/page-1.png",
          size: 100,
          sourceWidth: 600,
          sourceHeight: 300,
          frameHeight: 600,
          fileName: "import.pdf",
        },
        {
          pageIndex: 1,
          r2Key: "whiteboards/whiteboard_1/assets/imports/id/page-2.png",
          size: 100,
          sourceWidth: 600,
          sourceHeight: 300,
          frameHeight: 600,
          fileName: "import.pdf",
        },
      ],
    })).toThrow(PdfImportPlacementAbortedError);

    // The fake transaction exposes that mutation began. The real tldraw/SQLite
    // wrapper observes the throw and rolls the entire transaction back.
    expect((records.get("shape:page-0") as { props: { h: number } }).props.h)
      .not.toBe(originalHeight);
  });

  // A retry cannot clear this state, so it must not be reported as the
  // page-limit rejection an operator would go chase.
  it("reports a partially applied import distinctly from a page-limit conflict", () => {
    const importId = "00000000-0000-4000-8000-000000000002";
    const records = new Map<string, TLRecord>();
    records.set("page:page", {
      id: "page:page",
      typeName: "page",
      name: "Page 1",
      index: "a1",
      meta: {},
    } as TLRecord);
    const frame = pageFrame(0, "a2" as IndexKey);
    records.set(frame.id, frame);
    // Only the first of the two requested pages is present.
    records.set(`shape:pdf-page-${importId}-0`, {
      id: `shape:pdf-page-${importId}-0`,
      typeName: "shape",
      type: "image",
      parentId: frame.id,
      index: "a1" as IndexKey,
      x: 0,
      y: 0,
      rotation: 0,
      isLocked: true,
      opacity: 1,
      props: {},
      meta: {},
    } as TLRecord);

    const snapshotBefore = new Map(records);
    const transaction = {
      values: () => records.values(),
      set: (id: TLRecord["id"], record: TLRecord) => records.set(id, record),
    };

    const pages = [0, 1].map((pageIndex) => ({
      pageIndex,
      r2Key: `whiteboards/whiteboard_1/assets/imports/${importId}/page-${pageIndex + 1}.png`,
      size: 100,
      sourceWidth: 600,
      sourceHeight: 300,
      frameHeight: 600,
      fileName: "import.pdf",
    }));

    let thrown: unknown;
    try {
      insertImportedPagesInTransaction(transaction, {
        importId,
        insertIndex: 1,
        pages,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(PdfImportPartiallyAppliedError);
    expect(thrown).toMatchObject({ appliedPageCount: 1, requestedPageCount: 2 });
    // Naming *which* pages are present is what lets the import hand their
    // objects over before the rejection, instead of leaving a rollback free to
    // delete bytes the live shape above still references.
    expect((thrown as PdfImportPartiallyAppliedError).appliedPageIndices).toEqual([0]);
    // The detection runs before any write, so nothing was mutated.
    expect(records).toEqual(snapshotBefore);
  });

  it("names every image already on the canvas, even past one that lost its frame", () => {
    const importId = "00000000-0000-4000-8000-000000000004";
    const records = new Map<string, TLRecord>();
    records.set("page:page", { id: "page:page", typeName: "page", name: "Page 1", index: "a1", meta: {} } as TLRecord);
    const frame = pageFrame(1, "a3" as IndexKey);
    records.set(frame.id, frame);
    const image = (pageIndex: number, parentId: string) => ({
      id: `shape:pdf-page-${importId}-${pageIndex}`,
      typeName: "shape",
      type: "image",
      parentId,
      index: "a1" as IndexKey,
      x: 0,
      y: 0,
      rotation: 0,
      isLocked: true,
      opacity: 1,
      props: {},
      meta: {},
    } as TLRecord);
    // The first page's image sits outside any frame; the second is placed.
    records.set(`shape:pdf-page-${importId}-0`, image(0, "page:page"));
    records.set(`shape:pdf-page-${importId}-1`, image(1, frame.id));
    const transaction = {
      values: () => records.values(),
      set: (id: TLRecord["id"], record: TLRecord) => records.set(id, record),
    };
    const pages = [0, 1, 2].map((pageIndex) => ({
      pageIndex,
      r2Key: `whiteboards/whiteboard_1/assets/imports/${importId}/page-${pageIndex + 1}.png`,
      size: 100,
      sourceWidth: 600,
      sourceHeight: 300,
      frameHeight: 600,
      fileName: "import.pdf",
    }));

    let thrown: unknown;
    try {
      insertImportedPagesInTransaction(transaction, { importId, insertIndex: 1, pages });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PdfImportPartiallyAppliedError);
    expect((thrown as PdfImportPartiallyAppliedError).appliedPageIndices).toEqual([0, 1]);
  });

  it("stamps each imported page with the file and page it came from", () => {
    const importId = "00000000-0000-4000-8000-000000000003";
    const records = new Map<string, TLRecord>();
    records.set("page:page", {
      id: "page:page",
      typeName: "page",
      name: "Page 1",
      index: "a1",
      meta: {},
    } as TLRecord);
    const existing = pageFrame(0, "a2" as IndexKey);
    records.set(existing.id, existing);
    const transaction = {
      values: () => records.values(),
      set: (id: TLRecord["id"], record: TLRecord) => records.set(id, record),
    };

    insertImportedPagesInTransaction(transaction, {
      importId,
      insertIndex: 1,
      // The first page reuses the frame the user was standing on; the second
      // creates a new one. Both must carry provenance.
      reuse: { frameId: existing.id, height: 600 },
      pages: [0, 1].map((pageIndex) => ({
        pageIndex,
        r2Key: `whiteboards/whiteboard_1/assets/imports/${importId}/page-${pageIndex + 1}.png`,
        size: 100,
        sourceWidth: 600,
        sourceHeight: 300,
        frameHeight: 600,
        fileName: "import.pdf",
        sourceFileId: "asset_problem_set",
        sourcePageNumber: pageIndex + 1,
      })),
      author: { id: "user-maya", name: "Maya" },
    });

    // Each page image belongs to whoever imported it; the frames hold no author.
    const images = [...records.values()].filter((record) => record.typeName === "shape" && record.type === "image");
    expect(images.map((image) => image.meta)).toEqual([
      { createdBy: { id: "user-maya", name: "Maya" } },
      { createdBy: { id: "user-maya", name: "Maya" } },
    ]);

    expect((records.get(existing.id) as { meta: unknown }).meta).toEqual({
      sourceFileId: "asset_problem_set",
      sourcePageNumber: 1,
    });
    const created = [...records.values()].find(
      (record) =>
        record.typeName === "shape" &&
        record.type === WHITEBOARD_PAGE_SHAPE_TYPE &&
        record.id !== existing.id,
    );
    expect((created as { meta: unknown }).meta).toEqual({
      sourceFileId: "asset_problem_set",
      sourcePageNumber: 2,
    });
  });

  it("leaves page meta empty for an import with no source file", () => {
    const importId = "00000000-0000-4000-8000-000000000004";
    const records = new Map<string, TLRecord>();
    records.set("page:page", {
      id: "page:page",
      typeName: "page",
      name: "Page 1",
      index: "a1",
      meta: {},
    } as TLRecord);
    records.set("shape:page-0", pageFrame(0, "a2" as IndexKey));
    const transaction = {
      values: () => records.values(),
      set: (id: TLRecord["id"], record: TLRecord) => records.set(id, record),
    };

    insertImportedPagesInTransaction(transaction, {
      importId,
      insertIndex: 1,
      pages: [{
        pageIndex: 0,
        r2Key: `whiteboards/whiteboard_1/assets/imports/${importId}/page-1.png`,
        size: 100,
        sourceWidth: 600,
        sourceHeight: 300,
        frameHeight: 600,
        fileName: "import.pdf",
      }],
    });

    const created = [...records.values()].find(
      (record) =>
        record.typeName === "shape" &&
        record.type === WHITEBOARD_PAGE_SHAPE_TYPE &&
        record.id !== "shape:page-0",
    );
    expect((created as { meta: unknown }).meta).toEqual({});
    // An importer the room can no longer name leaves the image without an author.
    const image = [...records.values()].find((record) => record.typeName === "shape" && record.type === "image");
    expect(image?.meta).toEqual({});
  });
});

describe("pipelined PDF import placement", () => {
  const importId = "00000000-0000-4000-8000-000000000003";

  function importPage(pageIndex: number) {
    return {
      pageIndex,
      r2Key: `whiteboards/whiteboard_1/assets/imports/id/page-${pageIndex + 1}.png`,
      size: 100,
      sourceWidth: 600,
      sourceHeight: 300,
      frameHeight: 600,
      fileName: "import.pdf",
    };
  }

  function boardWith(frameCount: number) {
    const records = new Map<string, TLRecord>();
    records.set("page:page", {
      id: "page:page",
      typeName: "page",
      name: "Page 1",
      index: "a1",
      meta: {},
    } as TLRecord);
    let indexKey: IndexKey | undefined;
    for (let index = 0; index < frameCount; index += 1) {
      indexKey = getIndexAbove(indexKey);
      const frame = pageFrame(index, indexKey);
      records.set(frame.id, frame);
    }
    return {
      records,
      transaction: {
        values: () => records.values(),
        set: (id: TLRecord["id"], record: TLRecord) => records.set(id, record),
      },
    };
  }

  /** Page frames in document order, which is what "page N" means to a reader. */
  function frameOrder(records: Map<string, TLRecord>): string[] {
    return [...records.values()]
      .filter((record): record is TLRecord & { y: number } =>
        record.typeName === "shape" &&
        (record as { type?: string }).type === WHITEBOARD_PAGE_SHAPE_TYPE)
      .sort((left, right) => left.y - right.y)
      .map((record) => record.id);
  }

  // The regression this anchor exists for: a second batch positioned by a
  // client-side count lands wherever that count happens to point, and an insert
  // by somebody else in between makes it point into the middle of the batch
  // before it.
  it("places a continuation batch after its anchor even when a page is inserted between batches", () => {
    const { records, transaction } = boardWith(1);

    const first = insertImportedPagesInTransaction(transaction, {
      importId,
      insertIndex: 1,
      pages: [importPage(0)],
    });
    expect(first).not.toBeNull();

    // Somebody else adds a page at the very front while the import is mid-flight.
    const intruder = pageFrame(-1, "a0" as IndexKey);
    records.set(intruder.id, { ...intruder, y: -10_000 } as TLRecord);

    const second = insertImportedPagesInTransaction(transaction, {
      importId,
      // Stale by exactly the intruder: this is the number the old client sent.
      insertIndex: 1,
      after: { pageIndex: 0 },
      pages: [importPage(1)],
    });
    expect(second).not.toBeNull();

    const order = frameOrder(records);
    const firstPage = order.indexOf(`shape:pdf-frame-${importId}-0`);
    const secondPage = order.indexOf(`shape:pdf-frame-${importId}-1`);
    expect(firstPage).toBeGreaterThanOrEqual(0);
    expect(secondPage).toBe(firstPage + 1);
  });

  it("refuses a continuation whose anchor page is no longer in the document", () => {
    const { transaction } = boardWith(1);

    expect(() => insertImportedPagesInTransaction(transaction, {
      importId,
      insertIndex: 1,
      after: { pageIndex: 0 },
      pages: [importPage(1)],
    })).toThrow(PdfImportAnchorMissingError);
  });

  it("positions the first batch by index, since it has no predecessor", () => {
    const { records, transaction } = boardWith(2);

    const placement = insertImportedPagesInTransaction(transaction, {
      importId,
      insertIndex: 1,
      pages: [importPage(0)],
    });
    expect(placement).not.toBeNull();

    const order = frameOrder(records);
    expect(order.indexOf(`shape:pdf-frame-${importId}-0`)).toBe(1);
  });
});
