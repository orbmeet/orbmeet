import { describe, expect, it } from "vitest";
import { createShapeId } from "tldraw";

import { whiteboardTLSchema } from "@orbmeet/whiteboard-core/room-schema";
import { roomSnapshotToStoreSnapshot } from "./room-snapshot-conversion";

describe("roomSnapshotToStoreSnapshot", () => {
  it("ignores malformed document records without an id", () => {
    const snapshot = roomSnapshotToStoreSnapshot({
      schema: whiteboardTLSchema.serialize(),
      documents: [
        { state: { id: "shape:ok", typeName: "shape" } },
        { state: { typeName: "shape" } },
      ],
    });
    const store = snapshot.store as unknown as Record<string, unknown>;

    expect(store["shape:ok"]).toEqual({
      id: "shape:ok",
      typeName: "shape",
    });
    expect(store.undefined).toBeUndefined();
  });

  it("migrates records from the snapshot schema before stamping the current schema", () => {
    const legacySchema = structuredClone(whiteboardTLSchema.serialize());
    legacySchema.sequences["com.tldraw.shape.geo"] = 11;
    const geo = whiteboardTLSchema.types.shape.create({
      id: createShapeId("legacy-geo"),
      type: "geo",
      parentId: "page:legacy" as never,
      index: "a1" as never,
      x: 0,
      y: 0,
      rotation: 0,
      isLocked: false,
      opacity: 1,
      props: {
        w: 100,
        h: 100,
        geo: "rectangle",
        color: "black",
        labelColor: "black",
        fill: "none",
        dash: "draw",
        size: "m",
        font: "draw",
        align: "middle",
        verticalAlign: "middle",
        growY: 0,
        url: "",
        richText: { type: "doc", content: [] },
        scale: 1,
        flipX: false,
        flipY: false,
      },
      meta: {},
    });
    const legacyGeo = structuredClone(geo) as unknown as {
      id: string;
      props: Record<string, unknown>;
      [key: string]: unknown;
    };
    delete legacyGeo.props.flipX;
    delete legacyGeo.props.flipY;

    const snapshot = roomSnapshotToStoreSnapshot({
      schema: legacySchema,
      documents: [{ state: legacyGeo }],
    });
    const migratedGeo = snapshot.store[geo.id];

    expect(snapshot.schema).toEqual(whiteboardTLSchema.serialize());
    expect(migratedGeo).toMatchObject({
      props: { flipX: false, flipY: false },
    });
  });
});
