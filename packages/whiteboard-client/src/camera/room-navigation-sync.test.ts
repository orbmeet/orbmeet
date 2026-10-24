// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createUserId, InstancePresenceRecordType, type Editor } from "tldraw";
import { createRoomNavigation, ROOM_NAVIGATION_ID } from "@orbmeet/whiteboard-core/room-navigation";
import { boardWithPages, cleanups } from "../pages/test-board";
import { RoomNavigationSync, type RoomNavigationRole } from "./room-navigation-sync";
import type { PageNavigator } from "../pages/page-navigator";

const PRESENTER: RoomNavigationRole = { myUserId: "presenter", isPresenter: true, presents: true };
const FOLLOWER: RoomNavigationRole = { myUserId: "follower", isPresenter: false, presents: true };

function start(editor: Editor, navigator: PageNavigator, role: RoomNavigationRole, onPagePresented = vi.fn()) {
  const sync = new RoomNavigationSync(editor, navigator, role, onPagePresented);
  cleanups.push(sync.start());
  return { sync, onPagePresented };
}

/** The room's navigation as it arrives from the room. */
function receive(editor: Editor, fields: Parameters<typeof createRoomNavigation>[0]) {
  editor.store.mergeRemoteChanges(() => editor.store.put([createRoomNavigation(fields)]));
}

/** Someone else's session on the board, as their presence says. */
function present(editor: Editor, userId: string, userName = userId) {
  editor.store.mergeRemoteChanges(() =>
    editor.store.put([
      InstancePresenceRecordType.create({
        id: InstancePresenceRecordType.createId(userId),
        userId: createUserId(userId),
        userName,
        currentPageId: editor.getCurrentPageId(),
      }),
    ]),
  );
}

function glide(editor: Editor, frames = 200) {
  for (let frame = 0; frame < frames; frame += 1) editor.emit("tick", 16);
}

describe("RoomNavigationSync, presenting", () => {
  it("makes the page the presenter turns to the room's, outside undo", () => {
    const { editor, navigator, pages } = boardWithPages(3);
    const { onPagePresented } = start(editor, navigator, PRESENTER);

    navigator.changePage(2);

    expect(editor.store.get(ROOM_NAVIGATION_ID)).toMatchObject({
      pageId: pages[1].id,
      pageNumber: 2,
      presenterId: "presenter",
    });
    expect(onPagePresented).toHaveBeenLastCalledWith(pages[1].id);

    // Presenting is not something undo takes back.
    editor.undo();
    expect(editor.store.get(ROOM_NAVIGATION_ID)).toMatchObject({ pageId: pages[1].id });
  });

  it("comes back to where the room is when taking up presenting", () => {
    const { editor, navigator, pages } = boardWithPages(3);
    receive(editor, { pageId: pages[2].id, pageNumber: 3, presenterId: "presenter" });

    start(editor, navigator, PRESENTER);

    expect(navigator.director.view.get()?.pageId).toBe(pages[2].id);
    expect(editor.store.get(ROOM_NAVIGATION_ID)).toMatchObject({ pageId: pages[2].id });
  });

  it("names nobody as presenter for a page the room has not added here yet", () => {
    const { editor, navigator, pages } = boardWithPages(2);
    start(editor, navigator, PRESENTER);
    navigator.changePage(1);
    const before = editor.store.get(ROOM_NAVIGATION_ID);

    // The room added a page for this presenter; it has not synced in yet.
    navigator.showPage("shape:arriving", 3);

    expect(editor.store.get(ROOM_NAVIGATION_ID)).toEqual(before);
    expect(before?.pageId).toBe(pages[0].id);
  });

  it("starts a new presenter with everyone following, and keeps their own roam", () => {
    const { editor, navigator } = boardWithPages(2);
    receive(editor, { pageId: null, presenterId: "someone-else", roam: true });
    const { sync } = start(editor, navigator, PRESENTER);
    expect(editor.store.get(ROOM_NAVIGATION_ID)).toMatchObject({ presenterId: "presenter", roam: false });

    sync.setRoam(true);
    navigator.changePage(2);
    expect(editor.store.get(ROOM_NAVIGATION_ID)).toMatchObject({ roam: true, pageNumber: 2 });
  });
});

describe("RoomNavigationSync, following", () => {
  it("shows a follower the presenter's page whole, from where the room is when they join", () => {
    const { editor, navigator, pages } = boardWithPages(3);
    present(editor, "presenter", "Maya");
    receive(editor, { pageId: pages[1].id, pageNumber: 2, presenterId: "presenter" });
    const { sync } = start(editor, navigator, FOLLOWER);

    expect(sync.presenter.get()).toEqual({ userId: "presenter", userName: "Maya" });
    expect(navigator.director.view.get()).toEqual({ kind: "follow", pageId: pages[1].id });

    receive(editor, { pageId: pages[2].id, pageNumber: 3, presenterId: "presenter" });
    glide(editor);
    expect(navigator.currentPage.get()).toBe(3);
  });

  it("follows nobody whose session is not on the board", () => {
    const { editor, navigator, pages } = boardWithPages(3);
    receive(editor, { pageId: pages[2].id, pageNumber: 3, presenterId: "presenter" });
    const { sync } = start(editor, navigator, FOLLOWER);

    expect(sync.presenter.get()).toBeNull();
    expect(navigator.currentPage.get()).toBe(1);
  });

  it("lands on the page at the old number once the presenter's page is deleted", () => {
    const { editor, navigator, pages } = boardWithPages(3);
    present(editor, "presenter");
    receive(editor, { pageId: "shape:gone", pageNumber: 2, presenterId: "presenter" });
    start(editor, navigator, FOLLOWER);

    expect(navigator.director.view.get()).toEqual({ kind: "follow", pageId: pages[1].id });
  });

  it("stops following when the reader moves, and lands on the presenter's page when they follow again", async () => {
    const { editor, navigator, pages } = boardWithPages(3);
    present(editor, "presenter");
    receive(editor, { pageId: pages[1].id, pageNumber: 2, presenterId: "presenter" });
    const { sync } = start(editor, navigator, FOLLOWER);

    const camera = editor.getCamera();
    editor.setCamera({ ...camera, y: camera.y - 80 });
    await Promise.resolve();
    expect(sync.following.get()).toBe(false);

    receive(editor, { pageId: pages[2].id, pageNumber: 3, presenterId: "presenter" });
    glide(editor);
    expect(navigator.currentPage.get()).toBe(2);

    sync.follow();
    glide(editor);
    expect(navigator.currentPage.get()).toBe(3);
  });

  it("lets everyone go when the presenter lets them roam, and takes them back after", () => {
    const { editor, navigator, pages } = boardWithPages(3);
    present(editor, "presenter");
    receive(editor, { pageId: pages[0].id, pageNumber: 1, presenterId: "presenter" });
    const { sync } = start(editor, navigator, FOLLOWER);

    receive(editor, { pageId: pages[0].id, pageNumber: 1, presenterId: "presenter", roam: true });
    expect(sync.following.get()).toBe(false);

    receive(editor, { pageId: pages[2].id, pageNumber: 3, presenterId: "presenter", roam: false });
    glide(editor);
    expect(sync.following.get()).toBe(true);
    expect(navigator.currentPage.get()).toBe(3);
  });

  it("neither follows nor writes on a board that has no presenter", () => {
    const { editor, navigator, pages } = boardWithPages(3);
    present(editor, "presenter");
    receive(editor, { pageId: pages[2].id, pageNumber: 3, presenterId: "presenter" });
    start(editor, navigator, { ...FOLLOWER, presents: false });
    expect(navigator.currentPage.get()).toBe(1);

    const solo = boardWithPages(2);
    start(solo.editor, solo.navigator, { ...PRESENTER, presents: false });
    solo.navigator.changePage(2);
    expect(solo.editor.store.get(ROOM_NAVIGATION_ID)).toBeUndefined();
  });
});
