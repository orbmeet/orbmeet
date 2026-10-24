// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { WHITEBOARD_CONTROLS_BAND_PX } from "../camera/viewport-insets";
import { PageNavigator } from "./page-navigator";
import { boardOptions as options, boardWithPages, cleanups, makeBoard, settle } from "./test-board";

describe("PageNavigator", () => {
  it("starts on the page carried from the previous editor, and lands on it once the pages arrive", () => {
    const { editor } = makeBoard({ width: 390, height: 844 });
    const host = new PageNavigator(editor, options);
    for (let index = 0; index < 4; index += 1) host.addPage();

    const reader = new PageNavigator(editor, { ...options, canManagePages: false, startPage: 3 });
    expect(reader.currentPage.get()).toBe(3);
    cleanups.push(reader.start());
    reader.setSyncReady(true);

    expect(reader.initialCameraReady.get()).toBe(true);
    expect(reader.currentPage.get()).toBe(3);
    expect(reader.restoredPage).toBe(3);
  });

  it("keeps the carried page while a reader waits for the document", () => {
    const reader = new PageNavigator(makeBoard({ width: 390, height: 844 }).editor, {
      ...options,
      canManagePages: false,
      startPage: 3,
    });
    cleanups.push(reader.start());
    reader.setSyncReady(true);
    expect(reader.initialCameraReady.get()).toBe(false);
    expect(reader.restoredPage).toBe(3);
  });

  it("adds no page for a client that may not manage pages", () => {
    const navigator = new PageNavigator(makeBoard({ width: 390, height: 844 }).editor, options);
    navigator.setCanManagePages(false);
    expect(navigator.addPage()).toBeNull();
    expect(navigator.insertPageAfter(1)).toBeNull();
    navigator.setCanManagePages(true);
    expect(navigator.addPage()?.number).toBe(1);
    expect(navigator.pages.get()).toHaveLength(1);
  });

  it("places the board on its first page as soon as sync is ready, with nothing to wait for", () => {
    const { editor, navigator, pages } = boardWithPages(3);
    expect(navigator.initialCameraReady.get()).toBe(true);
    const camera = editor.getCamera();
    expect((pages[0].y + camera.y) * camera.z).toBeCloseTo(WHITEBOARD_CONTROLS_BAND_PX, 3);
  });

  it("names the page it is going to as the move starts, not when it lands", () => {
    const { navigator } = boardWithPages(3);
    navigator.changePage(3);
    expect(navigator.currentPage.get()).toBe(3);
    expect(navigator.director.moving.get()).toBe(true);
  });

  it("stays exactly where a scroll leaves it, between two pages", async () => {
    const { editor, navigator, pages } = boardWithPages(3);
    const { cameraConstraints } = navigator;
    const seam = cameraConstraints.constrain(
      cameraConstraints.cameraCentring({ x: 600, y: pages[1].y + pages[1].height + 20 }, editor.getCamera().z),
    );

    editor.setCamera(seam);
    await settle();

    expect(editor.getCamera().y).toBeCloseTo(seam.y, 5);
    expect(editor.getCamera().x).toBeCloseTo(seam.x, 5);
    expect(navigator.director.view.get()?.kind).toBe("own");
  });

  it("never commits a camera above the first page", () => {
    const { editor } = boardWithPages(3);
    const before = editor.getCamera();

    editor.setCamera({ x: before.x, y: 10_000, z: before.z });

    expect(editor.getCamera().y).toBeCloseTo(WHITEBOARD_CONTROLS_BAND_PX / before.z, 3);
  });

  it("reads the page the board is on from the middle of the reader's own view", async () => {
    const { editor, navigator, pages } = boardWithPages(3);
    editor.setCamera(
      navigator.cameraConstraints.cameraCentring({ x: 600, y: pages[2].y + 100 }, editor.getCamera().z),
    );
    await settle();
    expect(navigator.currentPage.get()).toBe(3);
  });

  it("keeps the reader on their page when a page is inserted above it", () => {
    const { editor, navigator, pages } = boardWithPages(2);
    navigator.director.go({ kind: "page", pageId: pages[1].id }, { animate: false });
    const reading = pages[1].id;

    navigator.pageManager.insertPagesAt(0, 1);
    navigator.onPagesChanged();

    const moved = navigator.pages.get().find((page) => page.id === reading)!;
    expect(moved.number).toBe(3);
    expect(navigator.currentPage.get()).toBe(3);
    const camera = editor.getCamera();
    expect((moved.y + camera.y) * camera.z).toBeCloseTo(WHITEBOARD_CONTROLS_BAND_PX, 3);
  });

  it("lands on whichever page took a deleted page's place", () => {
    const { navigator, pages } = boardWithPages(3);
    navigator.director.go({ kind: "page", pageId: pages[1].id }, { animate: false });

    navigator.commitDeletePage(pages[1].id);

    expect(navigator.currentPage.get()).toBe(2);
    expect(navigator.director.view.get()).toEqual({ kind: "page", pageId: pages[2].id });
  });

  it("is on a page added elsewhere as soon as it is asked to be, and goes there once it arrives", () => {
    const { editor, navigator } = boardWithPages(1);
    const pending = "shape:arriving";

    navigator.showPage(pending, 2);

    expect(navigator.currentPage.get()).toBe(2);
    const waiting = editor.getCamera();
    for (let frame = 0; frame < 20; frame += 1) editor.emit("tick", 16);
    expect(editor.getCamera()).toEqual(waiting);

    // The frame lands, as the server's insert syncs in.
    const [inserted] = navigator.pageManager.insertPagesAt(1, 1);
    editor.run(() => {
      const shape = editor.getShape(inserted)!;
      editor.deleteShape(inserted);
      editor.createShape({ ...shape, id: pending as never });
    });
    navigator.onPagesChanged();
    for (let frame = 0; frame < 200; frame += 1) editor.emit("tick", 16);

    const arrived = navigator.pages.get().find((page) => page.id === pending)!;
    expect(arrived.number).toBe(2);
    expect(navigator.currentPage.get()).toBe(2);
    const camera = editor.getCamera();
    expect((arrived.y + camera.y) * camera.z).toBeCloseTo(WHITEBOARD_CONTROLS_BAND_PX, 3);
  });
});
