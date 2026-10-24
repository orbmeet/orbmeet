import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toRichText, type TLRecord, type TLShape, type TLShapeId } from "@tldraw/tlschema";
import type { IndexKey } from "@tldraw/utils";
import { whiteboardTLSchema } from "@orbmeet/whiteboard-core/room-schema";
import { WHITEBOARD_PAGE_SHAPE_TYPE } from "@orbmeet/whiteboard-core/page-shape-schema";
import { afterEach, describe, expect, it } from "vitest";
import { getPageFrameRecords, isPageRecord } from "@orbmeet/whiteboard-core/page-frame-model";
import { createTestRoom } from "./room-test-support.ts";
import type { Room } from "./room.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function records(room: Room): TLRecord[] {
  return (room as unknown as { sync: { getCurrentSnapshot(): { documents: Array<{ state: TLRecord }> } } }).sync
    .getCurrentSnapshot()
    .documents.map((document) => document.state);
}

function write(room: Room, record: TLRecord): void {
  (room as unknown as { sync: { storage: { transaction(run: (t: { set(id: string, r: TLRecord): void }) => void): unknown } } })
    .sync.storage.transaction((transaction) => transaction.set(record.id, record));
}

describe("Room: content from before everything was kept on a page", () => {
  it("is put on the page under it when the room opens, where it was on screen", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "orbmeet-loose-"));
    dirs.push(dataDir);

    const first = createTestRoom("meet-loose", dataDir);
    const canvas = records(first).find(isPageRecord)!;
    for (const [index, y] of [[1, 0], [2, 715]] as const) {
      write(first, whiteboardTLSchema.types.shape.create({
        id: `shape:page-${index}` as TLShapeId,
        type: WHITEBOARD_PAGE_SHAPE_TYPE,
        parentId: canvas.id,
        index: `a${index}` as IndexKey,
        x: 0,
        y,
        props: { w: 1200, h: 675, name: `Page ${index}`, background: "white" },
      }));
    }
    const page = getPageFrameRecords(records(first)).at(-1)!;
    // An older board: a shape on the canvas itself, over the second page.
    const loose = whiteboardTLSchema.types.shape.create({
      id: "shape:legacy" as TLShapeId,
      type: "geo",
      parentId: canvas.id,
      index: "a9" as IndexKey,
      x: 120,
      y: page.y + 200,
      props: geoProps({ w: 100, h: 80 }),
    }) as TLShape;
    write(first, loose);
    first.close();

    const reopened = createTestRoom("meet-loose", dataDir);
    const attached = records(reopened).find((record) => record.id === loose.id) as TLShape;
    expect(attached.parentId).toBe(page.id);
    expect(attached.x).toBe(120 - page.x);
    expect(attached.y).toBe(200);
    reopened.close();
  });

  // Attaching a shape never makes it less valid, but a board can hold one the
  // schema refuses today. Leaving it where it is keeps the room openable.
  it("leaves a shape the schema refuses where it is, and opens the room", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "orbmeet-loose-invalid-"));
    dirs.push(dataDir);

    const first = createTestRoom("meet-loose-invalid", dataDir);
    const canvas = records(first).find(isPageRecord)!;
    const broken = {
      ...whiteboardTLSchema.types.shape.create({
        id: "shape:broken" as TLShapeId,
        type: "geo",
        parentId: canvas.id,
        index: "a9" as IndexKey,
        props: geoProps({ w: 100, h: 80 }),
      }),
      props: { w: 100, h: 80 },
    } as unknown as TLShape;
    write(first, broken);
    first.close();

    const reopened = createTestRoom("meet-loose-invalid", dataDir);
    const kept = records(reopened).find((record) => record.id === broken.id) as TLShape;
    expect(kept.parentId).toBe(canvas.id);
    reopened.close();
  });
});

/** A geo shape's props, complete as the schema validates them. */
function geoProps(size: { w: number; h: number }) {
  return {
    geo: "rectangle",
    dash: "draw",
    url: "",
    growY: 0,
    scale: 1,
    flipX: false,
    flipY: false,
    labelColor: "black",
    color: "black",
    fill: "none",
    size: "m",
    font: "draw",
    align: "middle",
    verticalAlign: "middle",
    richText: toRichText(""),
    ...size,
  };
}
