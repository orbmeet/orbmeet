import { describe, expect, it } from "vitest";
import {
  classifyIncomingDiff,
  classifyIncomingDiffSizeEffect,
  getPageFrameIdsFromSnapshot,
  JsonMessageAssembler,
} from "./page-frame-guard.ts";

// What a push does to the board's pages, and whether it is a message our
// client could have sent at all. What each record may hold, and who may write
// it, is the authorizers' (room-record-authorizers.room.test.ts).

const whiteboardPage = {
  id: "shape:whiteboard-page-1",
  typeName: "shape",
  type: "whiteboard-page",
  x: 0,
  y: 0,
  props: { w: 1200, h: 900, name: "Page 1", background: "white" },
  meta: {},
};

const snapshot = {
  documents: [
    { state: whiteboardPage, lastChangedClock: 1 },
    { state: { id: "shape:box-1", typeName: "shape", type: "geo", meta: {} }, lastChangedClock: 2 },
  ],
};

const pageFrameIds = getPageFrameIdsFromSnapshot(snapshot);
const page2 = { ...whiteboardPage, id: "shape:whiteboard-page-2" };

function classify(diff: Record<string, unknown>, maxPageFrames = Infinity, ids: ReadonlySet<string> = pageFrameIds) {
  return classifyIncomingDiff({ type: "push", diff }, ids, maxPageFrames);
}

/** On a board with a second page, so a removal never takes the last one. */
const twoPages = new Set([...pageFrameIds, page2.id]);

describe("page frame guard", () => {
  it("finds page frame ids in a room snapshot", () => {
    expect([...pageFrameIds]).toEqual(["shape:whiteboard-page-1"]);
  });

  it("notices every way a push touches a page frame", () => {
    expect(classify({ [page2.id]: ["put", page2] })).toBe("page-frames");
    expect(classify({ [whiteboardPage.id]: ["patch", { x: ["put", 50] }] })).toBe("page-frames");
    expect(classify({ [whiteboardPage.id]: ["remove"] }, Infinity, twoPages)).toBe("page-frames");
    // A put that overwrites a known page with another shape demotes it.
    expect(classify({ [whiteboardPage.id]: ["put", { ...whiteboardPage, type: "frame" }] }, Infinity, twoPages))
      .toBe("page-frames");
  });

  it("allows what touches no page frame", () => {
    expect(classify({ "shape:box-1": ["patch", { x: ["put", 100] }] })).toBe("allow");
    expect(classifyIncomingDiff({ type: "connect" }, pageFrameIds)).toBe("allow");
  });

  it("refuses a page-frame create that would exceed the server limit", () => {
    expect(classify({ [page2.id]: ["put", page2] }, 1)).toBe("page-limit-exceeded");
  });

  it("allows an atomic page-frame replacement at the server limit", () => {
    expect(classify({ [whiteboardPage.id]: ["remove"], [page2.id]: ["put", page2] }, 1)).toBe("page-frames");
  });

  it("refuses to remove a board's last page, however the push does it (REPORT #2)", () => {
    expect(classify({ [whiteboardPage.id]: ["remove"] })).toBe("last-page");
    expect(classify({ [whiteboardPage.id]: ["put", { ...whiteboardPage, type: "geo" }] })).toBe("last-page");
    // Replacing the last page with another in one push leaves a page.
    expect(classify({ [whiteboardPage.id]: ["remove"], [page2.id]: ["put", page2] })).toBe("page-frames");
    // A board with no pages yet is not losing its last one.
    expect(classify({ [whiteboardPage.id]: ["remove"] }, Infinity, new Set())).toBe("allow");
  });

  it("classifies deletion-only pushes as safe room shrinkage", () => {
    expect(classifyIncomingDiffSizeEffect({ type: "push", diff: { "shape:box-1": ["remove"] } })).toBe("remove-only");
    expect(classifyIncomingDiffSizeEffect({ type: "push", diff: { "shape:box-1": ["patch", { x: ["put", 2] }] } }))
      .toBe("may-grow");
  });

  it("separates pushes that mix removes with other ops from purely additive ones", () => {
    // tldraw builds one diff per push from added + updated + removed, so a
    // delete with any knock-on effect ships remove + patch together. Its wire
    // size does not bound the growth it causes, so it must not be judged like a
    // pure write — that rejected the deletes a full room needs to recover.
    expect(classifyIncomingDiffSizeEffect({
      type: "push",
      diff: { "shape:gone": ["remove"], "shape:neighbour": ["patch", { parentId: ["put", "shape:frame-1"] }] },
    })).toBe("may-shrink");
    expect(classifyIncomingDiffSizeEffect({
      type: "push",
      diff: { "shape:gone": ["remove"], "shape:new": ["put", { typeName: "shape", id: "shape:new" }] },
    })).toBe("may-shrink");
    expect(classifyIncomingDiffSizeEffect({
      type: "push",
      diff: { "shape:a": ["put", { typeName: "shape", id: "shape:a" }], "shape:b": ["patch", { x: ["put", 2] }] },
    })).toBe("may-grow");
  });
});

describe("JsonMessageAssembler", () => {
  it("assembles tldraw chunked JSON messages", () => {
    const assembler = new JsonMessageAssembler();
    expect(assembler.handleMessage('1_{"type":"')).toBeNull();
    expect(assembler.handleMessage('0_push"}')).toEqual({
      data: { type: "push" },
      stringified: '{"type":"push"}',
    });
  });

  it("reports malformed complete JSON without throwing", () => {
    const assembler = new JsonMessageAssembler();
    const result = assembler.handleMessage('{"type":');
    expect(result).toEqual({ error: expect.any(Error) });
  });

  it("rejects an announced chunk count beyond the hard cap", () => {
    const assembler = new JsonMessageAssembler();
    const result = assembler.handleMessage(`${1_000_000}_partial`);
    expect(result).toEqual({ error: expect.any(Error) });
  });

  it("rejects reassembly that grows past the byte cap", () => {
    const assembler = new JsonMessageAssembler();
    const huge = "x".repeat(9 * 1024 * 1024);
    // First chunk fits; the second pushes the running total over 16 MB.
    expect(assembler.handleMessage(`1_${huge}`)).toBeNull();
    expect(assembler.handleMessage(`0_${huge}`)).toEqual({
      error: expect.any(Error),
    });
  });

  it("counts chunk limits in UTF-8 bytes, not UTF-16 code units", () => {
    const assembler = new JsonMessageAssembler();
    const huge = "😀".repeat(5 * 1024 * 1024);

    expect(assembler.handleMessage(`0_${huge}`)).toEqual({
      error: expect.any(Error),
    });
  });
});

describe("messages our client could not have sent", () => {
  it("refuses an op that is not a tuple, or has nothing to put or patch", () => {
    expect(classify({ "shape:a": "put" })).toBe("forbidden");
    expect(classify({ "page:main": { put: { typeName: "page" } } })).toBe("forbidden");
    expect(classify({ "shape:a": [] })).toBe("forbidden");
    expect(classify({ "page:1": ["put"] })).toBe("forbidden");
    expect(classify({ "shape:a": ["patch", "x"] })).toBe("forbidden");
  });

  it("refuses a record op whose kind is not put, patch or remove", () => {
    // RecordOpType is exactly those three. An unrecognized kind must not fall
    // through to "allow": that verdict also tells the caller no page-frame
    // mutation happened, so the guard's id set would stop tracking the document.
    for (const kind of ["append", "delete", "replace", "", null, 7]) {
      expect(classify({ "shape:a": [kind, { typeName: "shape" }] })).toBe("forbidden");
    }
    expect(classify({ [whiteboardPage.id]: ["append", [{ props: { w: 1 } }], 0] })).toBe("forbidden");
  });

  it("refuses a prototype-polluting key anywhere in the diff", () => {
    // sync-core's applyObjectDiff would act on it before any authorizer runs.
    expect(classifyIncomingDiff(JSON.parse('{"type":"push","diff":{"__proto__":["remove"]}}'), pageFrameIds))
      .toBe("forbidden");
    expect(classifyIncomingDiff(
      JSON.parse('{"type":"push","diff":{"shape:a":["patch",{"props":["patch",{"__proto__":["put",{"x":1}]}]}]}}'),
      pageFrameIds,
    )).toBe("forbidden");
    expect(classify({ "shape:a": ["patch", { props: ["patch", { constructor: ["put", 1] }] }] })).toBe("forbidden");
  });

  it("still allows well-formed ordinary ops", () => {
    expect(classify({ "shape:a": ["patch", { x: ["put", 1] }] }, Infinity, new Set())).toBe("allow");
  });
});
