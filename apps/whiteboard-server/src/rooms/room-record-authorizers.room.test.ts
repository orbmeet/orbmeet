import { whiteboardTLSchema } from "@orbmeet/whiteboard-core/room-schema";
import * as syncCore from "@tldraw/sync-core";
const { getTlsyncProtocolVersion } = syncCore as unknown as { getTlsyncProtocolVersion(): number };
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestRoom } from "./room-test-support.ts";
import type { TldrawSocket, SocketSession } from "./room-types.ts";
import type { Room } from "./room.ts";
import type { WhiteboardRoomId } from "@orbmeet/whiteboard-core/whiteboard-room-id";

/**
 * The room's record rules, through a real tldraw room: what a client pushes
 * is applied and migrated before the authorizers judge it, so a rule holds
 * however the client encoded the write. Every refusal below is paired with
 * the same write made acceptably, which lands, so it is the rule refusing it
 * and not the schema.
 */

const tempDirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const BOARD = "wb_test";
const OWN_ASSET = `/api/wb-assets/whiteboards/${BOARD}/assets/whiteboard_asset_1.png`;

function session(whiteboardRoomId: WhiteboardRoomId, userId: string, manager: boolean, tab = "sess"): SocketSession {
  return {
    tldrawSessionId: `${userId}:${tab}`,
    userId,
    userName: `User ${userId}`,
    role: "participant",
    capabilities: { canEditWhiteboard: true, canControlSurface: manager, canManageWhiteboard: manager },
    grantPrincipal: { type: "user", id: userId },
    whiteboardRoomId,
    connectionId: `conn-${userId}`,
    documentId: BOARD,
  };
}

/** A room with a connected manager and a connected editor, and a way to push as each. */
function board() {
  const whiteboardRoomId = `meet-rules-${tempDirs.length}` as WhiteboardRoomId;
  const dir = mkdtempSync(join(tmpdir(), "orbmeet-room-rules-"));
  tempDirs.push(dir);
  const room: Room = createTestRoom(whiteboardRoomId, dir, vi.fn(), { whiteboardId: BOARD });
  const clocks = new Map<string, number>();
  const connect = (data: SocketSession) => {
    room.handleConnect({ readyState: 1, send: () => {}, close: () => {} } satisfies TldrawSocket, data);
    room.handleMessage(data.tldrawSessionId, JSON.stringify({
      type: "connect",
      protocolVersion: getTlsyncProtocolVersion(),
      schema: whiteboardTLSchema.serialize(),
      connectRequestId: "c",
      lastServerClock: -1,
    }));
    return (diff: Record<string, unknown>) => {
      const clientClock = (clocks.get(data.tldrawSessionId) ?? 0) + 1;
      clocks.set(data.tldrawSessionId, clientClock);
      room.handleMessage(data.tldrawSessionId, JSON.stringify({ type: "push", clientClock, diff }));
    };
  };
  const asManager = connect(session(whiteboardRoomId, "manager-1", true));
  const asEditor = connect(session(whiteboardRoomId, "editor-1", false));
  /** The manager, demoted in D1, in a tab that reconnected with an editor's token. */
  const asDemotedTab = connect(session(whiteboardRoomId, "manager-1", false, "demoted-tab"));
  const stored = (id: string) =>
    (room.document.currentSnapshot().documents as unknown as Array<{ state: Record<string, unknown> }>)
      .find(({ state }) => state.id === id)?.state;
  /** A stored record's props; the record must be there. */
  const propsOf = (id: string) => {
    const record = stored(id);
    if (!record) throw new Error(`${id} is not stored`);
    return record.props as Record<string, unknown>;
  };
  return { room, asManager, asEditor, asDemotedTab, stored, propsOf };
}

function shape(id: string, type: string, props: Record<string, unknown>, meta: Record<string, unknown> = {}) {
  return {
    id, typeName: "shape", type, x: 0, y: 0, rotation: 0, index: "a1", parentId: "page:page",
    isLocked: false, opacity: 1, meta, props,
  };
}

const textProps = {
  color: "black", size: "m", font: "draw", textAlign: "start", w: 100,
  richText: { type: "doc", content: [] }, scale: 1, autoSize: true,
};
const pageFrame = (id: string, name = "Page") => shape(id, "whiteboard-page", { w: 1200, h: 900, name, background: "white" });

function imageAsset(id: string, src: string | null) {
  return {
    id, typeName: "asset", type: "image", meta: {},
    props: { w: 1, h: 1, name: "a.png", isAnimated: false, mimeType: "image/png", src },
  };
}

describe("the room's record rules, as a client's pushes meet them", () => {
  it("credits a new shape to the session that pushed it, whatever the client claimed, and keeps it through edits", () => {
    const { asEditor, stored } = board();
    const author = { createdBy: { id: "editor-1", name: "User editor-1" } };

    asEditor({ "shape:note": ["put", shape("shape:note", "text", textProps, { createdBy: { id: "someone-else", name: "Maya" } })] });
    expect(stored("shape:note")?.meta).toEqual(author);

    asEditor({ "shape:note": ["patch", { meta: ["put", { tag: "kept", ...author }] }] });
    expect(stored("shape:note")?.meta).toEqual({ tag: "kept", ...author });

    // Rewriting or dropping the author is refused; the shape keeps it.
    asEditor({ "shape:note": ["patch", { meta: ["put", { createdBy: { id: "someone-else", name: "Maya" } }] }] });
    asEditor({ "shape:note": ["patch", { meta: ["put", {}] }] });
    expect(stored("shape:note")?.meta).toEqual({ tag: "kept", ...author });
  });

  it("refuses media from outside the board however the write is encoded", () => {
    const { asEditor, stored, propsOf } = board();
    asEditor({ "asset:pic": ["put", imageAsset("asset:pic", OWN_ASSET)] });
    expect(propsOf("asset:pic").src).toBe(OWN_ASSET);

    const evil = "https://evil.example/x.png";
    asEditor({ "asset:pic": ["patch", { props: ["patch", { src: ["put", evil] }] }] });
    asEditor({ "asset:pic": ["patch", { props: ["put", { ...imageAsset("asset:pic", evil).props }] }] });
    asEditor({ "asset:pic": ["put", imageAsset("asset:pic", evil)] });
    asEditor({ "asset:other": ["put", imageAsset("asset:other", evil)] });
    expect(propsOf("asset:pic").src).toBe(OWN_ASSET);
    expect(stored("asset:other")).toBeUndefined();

    // The unresolved upload tldraw writes first, then its own source.
    asEditor({ "asset:pending": ["put", imageAsset("asset:pending", null)] });
    asEditor({ "asset:pending": ["patch", { props: ["patch", { src: ["put", OWN_ASSET] }] }] });
    expect(propsOf("asset:pending").src).toBe(OWN_ASSET);
  });

  it("refuses an unsafe url on any shape, written whole or patched in", () => {
    const { asEditor, stored, propsOf } = board();
    const embed = (url: string) => shape("shape:embed", "embed", { w: 300, h: 300, url });
    asEditor({ "shape:embed": ["put", embed("http://169.254.169.254/latest/meta-data/")] });
    expect(stored("shape:embed")).toBeUndefined();

    asEditor({ "shape:embed": ["put", embed("")] });
    asEditor({ "shape:embed": ["patch", { props: ["patch", { url: ["put", "http://10.0.0.1/internal"] }] }] });
    expect(propsOf("shape:embed").url).toBe("");
    asEditor({ "shape:embed": ["patch", { props: ["patch", { url: ["put", "https://example.com/page"] }] }] });
    expect(propsOf("shape:embed").url).toBe("https://example.com/page");
  });

  it("leaves page frames to managers", () => {
    const { asManager, asEditor, stored, propsOf } = board();
    asEditor({ "shape:page-2": ["put", pageFrame("shape:page-2")] });
    expect(stored("shape:page-2")).toBeUndefined();
    asManager({ "shape:page-2": ["put", pageFrame("shape:page-2")] });
    expect(stored("shape:page-2")).toBeDefined();
    // A second page, so a removal is judged as a removal, not as the board's last page.
    asManager({ "shape:page-3": ["put", pageFrame("shape:page-3")] });

    asEditor({ "shape:page-2": ["patch", { props: ["patch", { name: ["put", "Renamed"] }] }] });
    asEditor({ "shape:page-2": ["remove"] });
    expect(stored("shape:page-2")).toBeDefined();
    expect(propsOf("shape:page-2").name).toBe("Page");
    asManager({ "shape:page-2": ["patch", { props: ["patch", { name: ["put", "Renamed"] }] }] });
    expect(propsOf("shape:page-2").name).toBe("Renamed");
  });

  it("judges a write by the session that sent it, not by its user's other tabs (REVIEW #7)", () => {
    const { asManager, asDemotedTab, stored } = board();
    asManager({ "shape:page-2": ["put", pageFrame("shape:page-2")] });
    asManager({ "shape:page-3": ["put", pageFrame("shape:page-3")] });
    asDemotedTab({ "shape:page-2": ["remove"] });
    expect(stored("shape:page-2")).toBeDefined();
    asManager({ "shape:page-2": ["remove"] });
    expect(stored("shape:page-2")).toBeUndefined();
  });

  it("never lets a shape change type in place, so an editor cannot make a page frame", () => {
    const { asEditor, asManager, stored } = board();
    asEditor({ "shape:box": ["put", shape("shape:box", "text", textProps)] });
    asEditor({ "shape:box": ["patch", { type: ["put", "whiteboard-page"], props: ["put", pageFrame("x").props] }] });
    asManager({ "shape:box": ["patch", { type: ["put", "whiteboard-page"], props: ["put", pageFrame("x").props] }] });
    expect(stored("shape:box")?.type).toBe("text");
  });

  it("refuses a record id snapshots could not hold", () => {
    const { asEditor, stored } = board();
    const longId = `shape:${"x".repeat(600)}`;
    asEditor({ [longId]: ["put", shape(longId, "text", textProps)] });
    expect(stored(longId)).toBeUndefined();
    asEditor({ "shape:short": ["put", shape("shape:short", "text", textProps)] });
    expect(stored("shape:short")).toBeDefined();
  });

  it("refuses every write to the native page and document records", () => {
    const { asManager, stored } = board();
    const page = stored("page:page");
    asManager({
      "page:page": ["patch", { name: ["put", "Hijacked"] }],
      "page:extra": ["put", { ...page, id: "page:extra" }],
    });
    asManager({ "document:document": ["patch", { gridSize: ["put", 1] }] });
    expect(stored("page:page")).toEqual(page);
    expect(stored("page:extra")).toBeUndefined();
    expect((stored("document:document") as { gridSize: number }).gridSize).not.toBe(1);
  });
});

describe("the room's navigation, as a client's pushes meet it", () => {
  const navigation = (presenterId: string, pageId = "shape:page-2") => ({
    id: "orbmeet_navigation:room",
    typeName: "orbmeet_navigation",
    pageId,
    pageNumber: 2,
    presenterId,
    roam: false,
  });

  it("is written by whoever drives it, as themselves, and by nobody else", () => {
    const { asManager, asEditor, stored } = board();

    // With no navigation controller, a manager drives.
    asEditor({ "orbmeet_navigation:room": ["put", navigation("editor-1")] });
    expect(stored("orbmeet_navigation:room")).toBeUndefined();

    asManager({ "orbmeet_navigation:room": ["put", navigation("editor-1")] });
    expect(stored("orbmeet_navigation:room")).toBeUndefined();

    asManager({ "orbmeet_navigation:room": ["put", navigation("manager-1")] });
    expect(stored("orbmeet_navigation:room")).toMatchObject({ presenterId: "manager-1", pageId: "shape:page-2" });

    asManager({ "orbmeet_navigation:room": ["patch", { pageId: ["put", "shape:page-3"] }] });
    expect(stored("orbmeet_navigation:room")).toMatchObject({ pageId: "shape:page-3" });

    asEditor({ "orbmeet_navigation:room": ["patch", { pageId: ["put", "shape:page-1"] }] });
    asManager({ "orbmeet_navigation:room": ["remove"] });
    expect(stored("orbmeet_navigation:room")).toMatchObject({ pageId: "shape:page-3" });
  });

  it("follows the handoff: the controller drives, and the manager no longer does", () => {
    const { room, asManager, asEditor, stored } = board();
    expect(room.navigation.setController("editor-1", "manager-1")).toMatchObject({ ok: true });

    asManager({ "orbmeet_navigation:room": ["put", navigation("manager-1")] });
    expect(stored("orbmeet_navigation:room")).toBeUndefined();

    asEditor({ "orbmeet_navigation:room": ["put", navigation("editor-1")] });
    expect(stored("orbmeet_navigation:room")).toMatchObject({ presenterId: "editor-1" });
  });
});

describe("user records, as a client's pushes meet them", () => {
  const user = (id: string, name: string) => ({
    id: `user:${id}`, typeName: "user", name, color: "#123456", imageUrl: "", meta: {},
  });

  it("stores a session's own record under the name the room knows, and no one else's", () => {
    const { asEditor, stored } = board();

    asEditor({ "user:editor-1": ["put", user("editor-1", "Meeting Host")] });
    expect(stored("user:editor-1")).toMatchObject({ name: "User editor-1" });

    asEditor({ "user:manager-1": ["put", user("manager-1", "User manager-1")] });
    expect(stored("user:manager-1")).toBeUndefined();

    asEditor({ "user:editor-1": ["patch", { name: ["put", "Meeting Host"] }] });
    expect(stored("user:editor-1")).toMatchObject({ name: "User editor-1" });
  });
});
