import { describe, expect, it } from "vitest";
import { createUserId, type TLShape, type TLUser, UserRecordType } from "@tldraw/tlschema";
import { whiteboardTLSchema } from "@orbmeet/whiteboard-core/room-schema";
import { createRoomNavigation } from "@orbmeet/whiteboard-core/room-navigation";
import { roomRecordAuthorizers, type RecordAuthorizerHost } from "./room-record-authorizers.ts";
import type { SessionMeta } from "./room-types.ts";

const memberMeta = (overrides: Partial<SessionMeta> = {}) => ({
  userId: "editor-1",
  userName: "Editor",
  capabilities: { canEditWhiteboard: true, canControlSurface: false, canManageWhiteboard: false },
  writesSuspended: false,
  ...overrides,
}) as SessionMeta;

const managerMeta = (writesSuspended: boolean) => memberMeta({
  userId: "manager-1",
  userName: "Manager",
  capabilities: { canEditWhiteboard: true, canControlSurface: true, canManageWhiteboard: true },
  writesSuspended,
});

function authorizers(meta: () => SessionMeta, host: Partial<RecordAuthorizerHost> = {}) {
  return roomRecordAuthorizers({
    roomLabel: "room",
    sessionMeta: () => meta(),
    canAcceptMutations: () => true,
    isActiveNavigator: () => false,
    ...host,
  });
}

const session = (meta: SessionMeta) => ({ sessionId: "s", isReadonly: false, meta });

const page = { id: "shape:page-2", typeName: "shape", type: "whiteboard-page", meta: {}, props: {} } as unknown as TLShape;

function note(textLastEditedBy: string | null): TLShape {
  return {
    id: "shape:note",
    typeName: "shape",
    type: "note",
    meta: {},
    props: { textLastEditedBy },
  } as unknown as TLShape;
}

describe("roomRecordAuthorizers", () => {
  it("judges a session by its authority now, not when it connected", () => {
    let live = managerMeta(false);
    const authorize = authorizers(() => live).shape!;
    // tldraw hands over the meta the session connected with.
    const connected = session(managerMeta(false));

    expect(authorize({ session: connected, type: "delete", prev: page, next: null })).toBe(page);
    live = managerMeta(true);
    expect(authorize({ session: connected, type: "delete", prev: page, next: null })).toBeNull();
  });

  // tldraw writes a record type with no authorizer straight through, so a
  // type the schema gains without a rule here would be writable by anyone.
  it("has a rule for every document record type the room knows", () => {
    const rules = authorizers(() => memberMeta()) as Record<string, unknown>;
    const documentTypes = Object.entries(whiteboardTLSchema.types as Record<string, { scope: string }>)
      .filter(([, type]) => type.scope === "document")
      .map(([typeName]) => typeName);

    expect(documentTypes.length).toBeGreaterThan(0);
    expect(documentTypes.filter((typeName) => typeof rules[typeName] !== "function")).toEqual([]);
  });

  it("refuses every write while the document refuses writes", () => {
    const shape = { id: "shape:a", typeName: "shape", type: "geo", meta: {}, props: {} } as unknown as TLShape;
    const authorize = authorizers(() => memberMeta(), { canAcceptMutations: () => false }).shape!;

    expect(authorize({ session: session(memberMeta()), type: "create", prev: null, next: shape })).toBeNull();
  });

  describe("user records", () => {
    const meta = memberMeta();
    const own = UserRecordType.create({ id: createUserId(meta.userId), name: "Someone Else", color: "#000000" });
    const authorize = authorizers(() => meta).user!;

    it("stores a session's own record under the name the room knows", () => {
      expect(authorize({ session: session(meta), type: "create", prev: null, next: own })).toMatchObject({
        id: own.id,
        name: "Editor",
      });
    });

    it("refuses another user's record, a rename and an image", () => {
      const other = UserRecordType.create({ id: createUserId("manager-1"), name: "Editor", color: "#000000" });
      const stored: TLUser = { ...own, name: "Editor" };
      expect(authorize({ session: session(meta), type: "create", prev: null, next: other })).toBeNull();
      expect(authorize({ session: session(meta), type: "update", prev: stored, next: { ...stored, name: "Manager" } }))
        .toBeNull();
      expect(authorize({ session: session(meta), type: "update", prev: stored, next: { ...stored, imageUrl: "https://example.com/x.png" } }))
        .toBeNull();
      expect(authorize({ session: session(meta), type: "delete", prev: stored, next: null })).toBeNull();
    });
  });

  describe("note attribution", () => {
    const meta = memberMeta();
    const authorize = authorizers(() => meta).shape!;

    it("credits a new note's text to the session that made it", () => {
      const created = authorize({ session: session(meta), type: "create", prev: null, next: note("manager-1") }) as TLShape;
      expect((created.props as { textLastEditedBy: unknown }).textLastEditedBy).toBe("editor-1");
    });

    it("lets a session take, clear or keep a note's credit, never give it away", () => {
      const prev = note("manager-1");
      const write = (next: TLShape) => authorize({ session: session(meta), type: "update", prev, next });
      expect(write(note("editor-1"))).not.toBeNull();
      expect(write(note(null))).not.toBeNull();
      expect(write(note("manager-1"))).not.toBeNull();
      expect(write(note("someone-else"))).toBeNull();
    });
  });

  describe("the room's navigation", () => {
    const presenter = managerMeta(false);
    const record = createRoomNavigation({ pageId: "shape:page-2", pageNumber: 2, presenterId: presenter.userId });

    it("is written by the active navigator, as themselves", () => {
      const authorize = authorizers(() => presenter, { isActiveNavigator: (userId) => userId === presenter.userId })
        .orbmeet_navigation!;
      expect(authorize({ session: session(presenter), type: "create", prev: null, next: record })).toEqual(record);
      expect(
        authorize({ session: session(presenter), type: "update", prev: record, next: { ...record, presenterId: "editor-1" } }),
      ).toBeNull();
      expect(authorize({ session: session(presenter), type: "delete", prev: record, next: null })).toBeNull();
    });

    it("is refused to anyone who does not drive it", () => {
      const editor = memberMeta();
      const authorize = authorizers(() => editor, { isActiveNavigator: () => false }).orbmeet_navigation!;
      expect(
        authorize({ session: session(editor), type: "update", prev: record, next: { ...record, presenterId: editor.userId } }),
      ).toBeNull();
    });
  });
});
