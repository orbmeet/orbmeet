import { describe, expect, it } from "vitest";
import { createTLSchemaFromUtils } from "tldraw";
import {
  WHITEBOARD_RECORD_SCHEMAS,
  WHITEBOARD_SHAPE_SCHEMAS,
  whiteboardTLSchema,
} from "@orbmeet/whiteboard-core/room-schema";
import { whiteboardShapeUtils, whiteboardSyncShapeUtils } from "./whiteboard-shapes";

describe("the board client's record schema", () => {
  // The sync server knows the client's schema as whiteboardTLSchema; the
  // client itself builds its schema from its shape utils, as useSync does
  // with the options the board passes it.
  it("is the schema the sync server knows it by", () => {
    const client = createTLSchemaFromUtils({
      shapeUtils: whiteboardSyncShapeUtils,
      records: WHITEBOARD_RECORD_SCHEMAS,
    });
    expect(client.serialize()).toEqual(whiteboardTLSchema.serialize());
  });

  // `serialize()` holds migration versions only. A validator the client does
  // not share lets the editor keep a record the room refuses, so compare the
  // validators themselves, prop by prop.
  it("validates every shape prop with the server's validator", () => {
    const server: Record<string, { props?: Record<string, unknown> }> = WHITEBOARD_SHAPE_SCHEMAS;
    // `group` is a core shape: tldraw adds it to every editor itself.
    expect(whiteboardSyncShapeUtils.map((util) => util.type).sort()).toEqual(
      Object.keys(server).filter((type) => type !== "group").sort(),
    );
    const mismatches: string[] = [];
    for (const util of whiteboardSyncShapeUtils) {
      const serverProps = server[util.type]?.props ?? {};
      const clientProps: Record<string, unknown> = util.props ?? {};
      for (const key of new Set([...Object.keys(serverProps), ...Object.keys(clientProps)])) {
        if (clientProps[key] !== serverProps[key]) mismatches.push(`${util.type}.${key}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("validates the room's own records with the server's validators", () => {
    const client = createTLSchemaFromUtils({
      shapeUtils: whiteboardSyncShapeUtils,
      records: WHITEBOARD_RECORD_SCHEMAS,
    });
    for (const typeName of Object.keys(WHITEBOARD_RECORD_SCHEMAS)) {
      const clientType = (client.types as Record<string, { validator: unknown }>)[typeName];
      const serverType = (whiteboardTLSchema.types as Record<string, { validator: unknown }>)[typeName];
      expect(clientType.validator).toBe(serverType.validator);
    }
  });

  it("has one util per shape type", () => {
    const types = whiteboardSyncShapeUtils.map((util) => util.type);
    expect(new Set(types).size).toBe(types.length);
    expect(whiteboardShapeUtils.every((util) => types.includes(util.type))).toBe(true);
  });
});
