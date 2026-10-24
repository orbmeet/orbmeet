import { describe, expect, it } from "vitest";
import { WHITEBOARD_CONFIG } from "./config.ts";
import { createRoomNavigation } from "./room-navigation.ts";
import {
  computeWhiteboardDocumentContentHash,
  computeWhiteboardSnapshotHash,
  createEmptyWhiteboardRoomSnapshot,
  validateWhiteboardRoomSnapshot,
  validateWhiteboardSnapshotBody,
} from "./room-snapshot-validation.ts";

function validSnapshot() {
  return createEmptyWhiteboardRoomSnapshot();
}

describe("validateWhiteboardRoomSnapshot", () => {
  it("accepts a schema-valid room snapshot", () => {
    expect(validateWhiteboardRoomSnapshot(validSnapshot())).toMatchObject({ ok: true });
  });

  it("accepts the room's navigation, and refuses one its schema does not", () => {
    const snapshot = validSnapshot();
    snapshot.documents.push({
      lastChangedClock: 1,
      state: createRoomNavigation({ pageId: "shape:page", pageNumber: 2, presenterId: "user_1" }),
    });
    expect(validateWhiteboardRoomSnapshot(snapshot)).toMatchObject({ ok: true });

    const invalid = validSnapshot();
    invalid.documents.push({
      lastChangedClock: 1,
      state: { ...createRoomNavigation(), pageNumber: 0 } as never,
    });
    expect(validateWhiteboardRoomSnapshot(invalid)).toMatchObject({ ok: false });
  });

  it("rejects malformed and duplicate records", () => {
    const snapshot = validSnapshot();
    snapshot.documents.push(structuredClone(snapshot.documents[0]));
    expect(validateWhiteboardRoomSnapshot(snapshot)).toEqual({
      ok: false,
      error: expect.stringContaining("duplicate record"),
    });
  });

  it("rejects records that fail the tldraw runtime validator", () => {
    const snapshot = validSnapshot();
    snapshot.documents[0].state = { id: "document:document", typeName: "document", name: 42 } as never;
    expect(validateWhiteboardRoomSnapshot(snapshot)).toMatchObject({ ok: false });
  });

  it("applies the room's own page limit, not just schema validity", () => {
    // Schema validation alone accepts a document the live room would never have
    // let a client build, and a restore installs exactly that.
    const snapshot = validSnapshot();
    const template = snapshot.documents.find((entry) => entry.state.typeName === "page")!;
    for (let index = 0; index < WHITEBOARD_CONFIG.MAX_PAGES + 1; index += 1) {
      const page = structuredClone(template);
      page.state = { ...page.state, id: `page:extra_${index}` } as never;
      snapshot.documents.push(page);
    }

    expect(validateWhiteboardRoomSnapshot(snapshot)).toEqual({
      ok: false,
      error: expect.stringContaining(`${WHITEBOARD_CONFIG.MAX_PAGES}-page limit`),
    });
  });

  it("applies the page-name bound the live page guard applies", () => {
    const snapshot = validSnapshot();
    const page = snapshot.documents.find((entry) => entry.state.typeName === "page")!;
    page.state = {
      ...page.state,
      name: "x".repeat(WHITEBOARD_CONFIG.MAX_PAGE_NAME_LENGTH + 1),
    } as never;

    expect(validateWhiteboardRoomSnapshot(snapshot)).toEqual({
      ok: false,
      error: expect.stringContaining("over-long page name"),
    });
  });

  it("does not confuse inherited object names with duplicate record ids", () => {
    const snapshot = validSnapshot();
    snapshot.documents[0].state = {
      ...snapshot.documents[0].state,
      id: "toString",
    } as never;
    expect(validateWhiteboardRoomSnapshot(snapshot)).not.toEqual({
      ok: false,
      error: expect.stringContaining("duplicate record"),
    });
  });

  it("rejects tombstones that are unbounded or do not name document records", () => {
    const invalidId = validSnapshot();
    invalidId.tombstones = { "not-a-record-id": 1 };
    expect(validateWhiteboardRoomSnapshot(invalidId)).toEqual({
      ok: false,
      error: "Snapshot contains invalid tombstones",
    });

    const oversizedId = validSnapshot();
    oversizedId.tombstones = { [`shape:${"x".repeat(512)}`]: 1 };
    expect(validateWhiteboardRoomSnapshot(oversizedId)).toEqual({
      ok: false,
      error: "Snapshot contains invalid tombstones",
    });
  });

  it("returns only fields belonging to the RoomSnapshot contract", () => {
    const snapshot = { ...validSnapshot(), injectedAuthority: { enabled: true } };
    const result = validateWhiteboardRoomSnapshot(snapshot);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.snapshot).not.toHaveProperty("injectedAuthority");
  });

  it("returns migrated records and current schema metadata", () => {
    const snapshot = validSnapshot();
    (snapshot.schema as { sequences: Record<string, number> }).sequences[
      "com.tldraw.shape.code"
    ] = 0;
    snapshot.documents.push({
      lastChangedClock: 7,
      state: {
        id: "shape:legacy-code",
        typeName: "shape",
        type: "code",
        x: 0,
        y: 0,
        rotation: 0,
        index: "a2",
        parentId: "page:page",
        isLocked: false,
        opacity: 1,
        meta: {},
        props: {
          w: 500,
          h: 280,
          code: "x".repeat(50_001),
          output: "",
          language: "json",
          status: "running",
          executionTimeMs: -5,
          lockedBy: "user:legacy",
        },
      },
    } as never);

    const result = validateWhiteboardRoomSnapshot(snapshot);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const state = result.snapshot.documents.find(
      (document) => document.state.id === "shape:legacy-code",
    )?.state as unknown as { props: Record<string, unknown> };
    expect(state.props).toMatchObject({
      // `json` had no runner even in the browser era and has no toolchain now,
      // so it folds; `typescript` would survive, because the runner gained one.
      language: "javascript",
      status: "idle",
      executionTimeMs: 0,
    });
    expect(state.props.code).toHaveLength(50_000);
    expect(state.props).not.toHaveProperty("lockedBy");
    expect(result.snapshot.schema).toEqual(validSnapshot().schema);
  });
});

describe("validateWhiteboardSnapshotBody", () => {
  it("verifies the body hash", async () => {
    const body = JSON.stringify(validSnapshot());
    const hash = await computeWhiteboardSnapshotHash(body);
    await expect(validateWhiteboardSnapshotBody(body, hash)).resolves.toMatchObject({ ok: true, hash });
    await expect(validateWhiteboardSnapshotBody(body, "0".repeat(32))).resolves.toEqual({
      ok: false,
      error: "Snapshot hash does not match its body",
    });
    await expect(validateWhiteboardSnapshotBody(body, "")).resolves.toEqual({
      ok: false,
      error: "Snapshot hash does not match its body",
    });
  });
});

describe("computeWhiteboardDocumentContentHash", () => {
  it("ignores sync clocks, record order, and JSON key order", async () => {
    const left = validSnapshot();
    const right = structuredClone(left);
    right.documentClock = (left.documentClock ?? 0) + 100;
    right.documents.reverse();
    right.documents = right.documents.map((document) => ({
      lastChangedClock: document.lastChangedClock + 50,
      state: Object.fromEntries(Object.entries(document.state).reverse()) as typeof document.state,
    }));

    await expect(computeWhiteboardDocumentContentHash(right)).resolves.toBe(
      await computeWhiteboardDocumentContentHash(left),
    );
  });

  it("changes when a document record changes", async () => {
    const left = validSnapshot();
    const right = structuredClone(left);
    const page = right.documents.find((document) => document.state.typeName === "page");
    if (!page) throw new Error("expected a page");
    page.state = { ...page.state, name: "Different" } as typeof page.state;

    await expect(computeWhiteboardDocumentContentHash(right)).resolves.not.toBe(
      await computeWhiteboardDocumentContentHash(left),
    );
  });

  it("does not count where the presenter is as content", async () => {
    const left = validSnapshot();
    const right = structuredClone(left);
    right.documents.push({
      lastChangedClock: 1,
      state: createRoomNavigation({ pageId: "shape:page", pageNumber: 1, presenterId: "user_1" }),
    });

    await expect(computeWhiteboardDocumentContentHash(right)).resolves.toBe(
      await computeWhiteboardDocumentContentHash(left),
    );
  });

  it("refuses to hash duplicate record ids", async () => {
    const snapshot = validSnapshot();
    snapshot.documents.push(structuredClone(snapshot.documents[0]));
    await expect(computeWhiteboardDocumentContentHash(snapshot)).resolves.toBeNull();
  });

  it("returns null rather than throwing when schema migration throws", async () => {
    await expect(computeWhiteboardDocumentContentHash({
      schema: {},
      documents: [],
    })).resolves.toBeNull();
  });
});
