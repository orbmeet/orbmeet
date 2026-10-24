// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { boardGeometryKey, isRestingZoom, nextZoomStep, stepTowards } from "./camera-director";
import { WHITEBOARD_CONTROLS_BAND_PX } from "./viewport-insets";
import { boardWithPages, settle } from "../pages/test-board";
import { DEFAULT_WHITEBOARD_CHROME } from "../chrome/whiteboard-chrome";

describe("stepTowards", () => {
  it("closes most of the distance over a few frames, without overshooting", () => {
    let view = { x: 0, y: 0, z: 1 };
    const target = { x: 0, y: 1000, z: 1 };
    for (let frame = 0; frame < 6; frame += 1) {
      view = stepTowards(view, target, 16) ?? view;
    }
    expect(view.y).toBeGreaterThan(500);
    expect(view.y).toBeLessThan(1000);
  });

  it("zooms with the leader, in proportion, without overshooting", () => {
    let view = { x: 0, y: 0, z: 1 };
    const target = { x: 0, y: 0, z: 4 };
    const zooms: number[] = [];
    for (let frame = 0; frame < 30; frame += 1) {
      view = stepTowards(view, target, 16) ?? view;
      zooms.push(view.z);
    }
    expect(zooms.every((z, i) => z >= (zooms[i - 1] ?? 1))).toBe(true);
    expect(view.z).toBeGreaterThan(3.9);
    expect(view.z).toBeLessThanOrEqual(4);
  });

  it("takes as long to zoom in by a factor as to zoom out by it", () => {
    const zoomIn = stepTowards({ x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: 4 }, 16)!;
    const zoomOut = stepTowards({ x: 0, y: 0, z: 4 }, { x: 0, y: 0, z: 1 }, 16)!;
    expect(Math.log(zoomIn.z / 1)).toBeCloseTo(-Math.log(zoomOut.z / 4), 10);
  });

  it("stops once it is within half a screen pixel at the same zoom", () => {
    expect(stepTowards({ x: 0, y: 0, z: 2 }, { x: 0.1, y: -0.2, z: 2 }, 16)).toBeNull();
  });

  it("is not there while only the zoom differs", () => {
    expect(stepTowards({ x: 0, y: 0, z: 2 }, { x: 0, y: 0, z: 2.5 }, 16)).not.toBeNull();
  });
});

describe("resting zoom, geometry and zoom steps", () => {
  it("treats the fit and small drift around it as the fit, and a deliberate zoom as the reader's", () => {
    expect(isRestingZoom(1)).toBe(true);
    expect(isRestingZoom(1.08)).toBe(true);
    expect(isRestingZoom(Number.NaN)).toBe(true);
    expect(isRestingZoom(1.5)).toBe(false);
    expect(isRestingZoom(0.5)).toBe(false);
  });

  it("changes the geometry with the size and with the chrome that sets the insets, not with sub-pixels", () => {
    const base = boardGeometryKey({ width: 1024, height: 768 }, DEFAULT_WHITEBOARD_CHROME);
    expect(boardGeometryKey({ width: 1024.3, height: 767.8 }, DEFAULT_WHITEBOARD_CHROME)).toBe(base);
    expect(boardGeometryKey({ width: 1000, height: 768 }, DEFAULT_WHITEBOARD_CHROME)).not.toBe(base);
    expect(
      boardGeometryKey({ width: 1024, height: 768 }, { ...DEFAULT_WHITEBOARD_CHROME, toolbarVisible: false }),
    ).not.toBe(base);
  });

  it("steps zoom up and down through the zoom steps, stopping at the ends", () => {
    expect(nextZoomStep(1, 1)).toBeGreaterThan(1);
    expect(nextZoomStep(1, -1)).toBeLessThan(1);
    expect(nextZoomStep(nextZoomStep(1, 1), -1)).toBeCloseTo(1, 6);
    expect(nextZoomStep(1000, 1)).toBe(nextZoomStep(1000, 1));
  });
});

/** The reader's hands on the board, as tldraw reports them, before a zoom of theirs. */
function pinch(editor: { emit: (event: "event", info: never) => unknown }) {
  editor.emit("event", { type: "pinch", name: "pinch", point: { x: 0, y: 0, z: 1 }, delta: { x: 0, y: 0, z: 1 } } as never);
}

describe("CameraDirector", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Run the director's frames until it has arrived, or give up. */
  function glide(editor: { emit: (event: "tick", ms: number) => unknown }, frames = 200) {
    for (let frame = 0; frame < frames; frame += 1) editor.emit("tick", 16);
  }

  it("re-places a page when the board changes size, with no waiting", () => {
    const { editor, navigator, resize, pages } = boardWithPages(3);
    navigator.director.go({ kind: "page", pageId: pages[1].id }, { animate: false });

    resize({ width: 700, height: 900 });
    navigator.director.syncGeometry();

    const camera = editor.getCamera();
    expect(camera.z).toBeCloseTo(navigator.cameraConstraints.getFitZoom(), 6);
    expect((pages[1].y + camera.y) * camera.z).toBeCloseTo(WHITEBOARD_CONTROLS_BAND_PX, 3);
  });

  it("bends a move the board resizes under, landing where the page is now", () => {
    const { editor, navigator, resize, pages } = boardWithPages(3);
    navigator.changePage(3);
    glide(editor, 3);

    resize({ width: 600, height: 900 });
    navigator.director.syncGeometry();
    glide(editor);

    expect(navigator.director.moving.get()).toBe(false);
    // Where page 3 lands on the board as it is now — a phone's bands, at 600 wide.
    const { cameraConstraints } = navigator;
    const landing = cameraConstraints.cameraAtPageTop(pages[2], cameraConstraints.getFitZoom());
    const camera = editor.getCamera();
    expect(camera.z).toBeCloseTo(landing.z, 6);
    expect(camera.x).toBeCloseTo(landing.x, 4);
    expect(camera.y).toBeCloseTo(landing.y, 4);
  });

  it("keeps a reader's own place and zoom when the board changes size", async () => {
    const { editor, navigator, resize, pages } = boardWithPages(3);
    const { cameraConstraints } = navigator;
    const width = cameraConstraints.getFitZoom();
    pinch(editor);
    editor.setCamera(cameraConstraints.cameraCentring({ x: 400, y: pages[1].y + 300 }, width * 2));
    await settle();
    const top = cameraConstraints.getVisibleViewportBounds()!.y;

    resize({ width: 800, height: 600 });
    navigator.director.syncGeometry();

    // Twice the page's width on the board, as it is now.
    expect(editor.getCamera().z / cameraConstraints.getFitZoom()).toBeCloseTo(2, 4);
    expect(cameraConstraints.getVisibleViewportBounds()!.y).toBeCloseTo(top, 3);
  });

  it("announces the reader's own moves, and never its own", async () => {
    const { editor, navigator, pages } = boardWithPages(3);
    const own = vi.fn();
    navigator.director.onOwnMove(own);

    navigator.changePage(2);
    glide(editor);
    navigator.director.go({ kind: "page", pageId: pages[2].id }, { animate: false });
    await settle();
    expect(own).not.toHaveBeenCalled();

    const camera = editor.getCamera();
    editor.setCamera({ ...camera, y: camera.y - 50 });
    await settle();
    expect(own).toHaveBeenCalledTimes(1);
  });

  it("shows a follower the leader's page whole, and lets go once the reader moves", async () => {
    const { editor, navigator, pages } = boardWithPages(3);
    const { director, cameraConstraints } = navigator;
    director.setFollowing(true);

    // The leader is zoomed in to half the page's width: this reader sees the page.
    director.follow(pages[1].id);
    glide(editor);
    expect(editor.getCamera().z).toBeCloseTo(cameraConstraints.getWholePageZoom(pages[1]), 6);
    expect(cameraConstraints.getVisibleViewportBounds()!.y).toBeCloseTo(pages[1].y, 3);
    expect(navigator.currentPage.get()).toBe(2);

    const camera = editor.getCamera();
    editor.setCamera({ ...camera, y: camera.y - 80 });
    await settle();
    const left = editor.getCamera();

    director.follow(pages[2].id);
    glide(editor);
    expect(editor.getCamera()).toEqual(left);

    director.setFollowing(false);
    director.setFollowing(true);
    director.follow(pages[1].id);
    glide(editor);
    expect(editor.getCamera().y).not.toBeCloseTo(left.y, 3);
  });

  it("does nothing with the same view handed in again", () => {
    const { editor, navigator, pages } = boardWithPages(3);
    const { director } = navigator;
    director.setFollowing(true);
    director.follow(pages[1].id);
    glide(editor);
    const view = director.view.get();

    director.follow(pages[1].id);
    expect(director.view.get()).toBe(view);
    expect(director.moving.get()).toBe(false);
  });

  it("moves a follower only when the leader turns the page", () => {
    const { editor, navigator, pages } = boardWithPages(3, { width: 844, height: 390 });
    const { director } = navigator;
    director.setFollowing(true);
    director.follow(pages[1].id);
    glide(editor);
    const resting = editor.getCamera();

    for (let turn = 0; turn < 3; turn += 1) {
      director.follow(pages[1].id);
      glide(editor);
      expect(editor.getCamera()).toEqual(resting);
      expect(director.moving.get()).toBe(false);
    }

    director.follow(pages[2].id);
    glide(editor);
    expect(navigator.currentPage.get()).toBe(3);
  });

  it("lets a follower who zooms look on their own, and shows the page whole when they go back", async () => {
    const { editor, navigator, pages } = boardWithPages(3);
    const { director, cameraConstraints } = navigator;
    const own = vi.fn();
    director.onOwnMove(own);
    director.setFollowing(true);
    director.follow(pages[1].id);
    glide(editor);
    const whole = editor.getCamera().z;

    navigator.zoomIn();
    navigator.zoomIn();
    glide(editor);
    expect(director.view.get()?.kind).toBe("own");
    expect(editor.getCamera().z).toBeGreaterThan(whole * 1.05);

    director.setFollowing(false);
    director.setFollowing(true);
    director.follow(pages[2].id);
    glide(editor);
    expect(editor.getCamera().z).toBeCloseTo(cameraConstraints.getWholePageZoom(pages[2]), 6);
  });

  it("lets a follower who pinches look on their own", async () => {
    const { editor, navigator, pages } = boardWithPages(3);
    const { director, cameraConstraints } = navigator;
    const own = vi.fn();
    director.onOwnMove(own);
    director.setFollowing(true);
    director.follow(pages[1].id);
    glide(editor);

    const fit = cameraConstraints.getPageFitZoom(pages[1]);
    pinch(editor);
    editor.setCamera(cameraConstraints.cameraCentring({ x: 900, y: pages[1].y + 500 }, fit * 1.5));
    await settle();

    expect(own).toHaveBeenCalledTimes(1);
    expect(director.view.get()?.kind).toBe("own");
    expect(editor.getCamera().z / fit).toBeCloseTo(1.5, 4);
  });

  it("shows a follower on a phone held upright all of a tall page, wherever the leader has scrolled", () => {
    const { editor, navigator, pages } = boardWithPages(2, { width: 390, height: 844 });
    const { director, cameraConstraints } = navigator;
    // A portrait PDF page, taller than it is wide.
    editor.updateShapes([{ id: pages[0].id, type: "whiteboard-page", props: { h: 1697 } }]);
    navigator.onPagesChanged();
    const page = navigator.pages.get()[0];
    director.setFollowing(true);
    director.follow(page.id);
    glide(editor);

    const shown = cameraConstraints.getVisibleViewportBounds()!;
    expect(shown.y).toBeLessThanOrEqual(page.y + 1);
    expect(shown.y + shown.h).toBeGreaterThanOrEqual(page.y + page.height - 1);
  });

  it("springs a view left in the pull room back onto the last page", async () => {
    vi.useFakeTimers();
    const { editor, navigator, pages } = boardWithPages(3);
    const { cameraConstraints } = navigator;
    const camera = editor.getCamera();
    editor.setCamera(cameraConstraints.constrain({ ...camera, y: -100_000 }));
    await settle();
    expect(cameraConstraints.isInPullRoom(editor.getCamera())).toBe(true);

    vi.advanceTimersByTime(1_000);
    glide(editor);

    const last = pages[2];
    const rest = editor.getCamera();
    expect(cameraConstraints.isInPullRoom(rest)).toBe(false);
    expect((last.y + rest.y) * rest.z).toBeLessThan(editor.getViewportScreenBounds().h);
  });

  it("finishes the leader's move when let go mid-glide, and rests where they were going", () => {
    const { editor, navigator, pages } = boardWithPages(3);
    const { director, cameraConstraints } = navigator;
    director.setFollowing(true);
    director.follow(pages[2].id);
    glide(editor, 2);

    director.setFollowing(false);
    glide(editor);

    expect(navigator.currentPage.get()).toBe(3);
    const landing = director.resolve({ kind: "follow", pageId: pages[2].id })!;
    expect(editor.getCamera().y).toBeCloseTo(landing.y, 4);
    expect(editor.getCamera().z).toBeCloseTo(cameraConstraints.getWholePageZoom(pages[2]), 6);
  });

  it("keeps a follower's zoom on screen when let go at rest", () => {
    const { editor, navigator, pages } = boardWithPages(3);
    const { director } = navigator;
    director.setFollowing(true);
    director.follow(pages[1].id);
    glide(editor);
    navigator.zoomIn();
    glide(editor);
    const zoomed = editor.getCamera();

    director.setFollowing(false);
    glide(editor);

    expect(editor.getCamera()).toEqual(zoomed);
    expect(director.view.get()?.kind).toBe("own");
  });

  it("names the page the leader is going to, not the page a follower is passing", () => {
    const { editor, navigator, pages } = boardWithPages(3);
    navigator.director.setFollowing(true);
    navigator.director.follow(pages[2].id);
    glide(editor, 2);
    expect(navigator.currentPage.get()).toBe(3);
  });

  it("stays where the reader took the board when they stop following", async () => {
    const { editor, navigator, pages } = boardWithPages(3);
    const { director } = navigator;
    director.setFollowing(true);
    director.follow(pages[2].id);
    glide(editor);

    const camera = editor.getCamera();
    editor.setCamera({ ...camera, y: camera.y + 300 });
    await settle();
    const own = editor.getCamera();
    director.setFollowing(false);
    glide(editor);

    expect(editor.getCamera()).toEqual(own);
  });


  it("keeps a reader's page number and place when pages are inserted or deleted above", async () => {
    const { editor, navigator, pages } = boardWithPages(4);
    const { cameraConstraints, pageManager } = navigator;
    editor.setCamera(cameraConstraints.cameraCentring({ x: 600, y: pages[2].y + 300 }));
    await settle();
    expect(navigator.currentPage.get()).toBe(3);
    const before = cameraConstraints.getVisibleBandFor(editor.getCamera(), navigator.pages.get())!;

    pageManager.insertPagesAt(0, 2);
    navigator.onPagesChanged();
    expect(navigator.currentPage.get()).toBe(5);
    const after = cameraConstraints.getVisibleBandFor(editor.getCamera(), navigator.pages.get())!;
    expect(after.page.id).toBe(before.page.id);
    expect(after.rect.y).toBeCloseTo(before.rect.y, 4);

    pageManager.deletePage(navigator.pages.get()[0].id);
    navigator.onPagesChanged();
    expect(navigator.currentPage.get()).toBe(4);
    expect(cameraConstraints.getVisibleBandFor(editor.getCamera(), navigator.pages.get())!.page.id).toBe(before.page.id);
  });

  it("says Fit until the reader zooms, whatever shape of page they scroll onto", async () => {
    // A laptop's board short enough that a 16:9 page is fitted whole, under a tall PDF page.
    const { editor, navigator, pages } = boardWithPages(1, { width: 1300, height: 640 });
    const { director, cameraConstraints } = navigator;
    editor.updateShapes([{ id: pages[0].id, type: "whiteboard-page", props: { h: 1697 } }]);
    navigator.onPagesChanged();
    navigator.addPage();
    const [tall, wide] = navigator.pages.get();
    expect(cameraConstraints.getPageFitZoom(wide)).toBeLessThan(cameraConstraints.getPageFitZoom(tall));

    director.go({ kind: "page", pageId: tall.id }, { animate: false });
    expect(navigator.zoomPercent.get()).toBeNull();
    const zoom = editor.getCamera().z;

    // Scrolling down onto the wide page changes neither the zoom nor what the control says.
    editor.setCamera(cameraConstraints.constrain(cameraConstraints.cameraCentring({ x: 600, y: wide.y + 300 }, zoom)));
    await settle();
    expect(editor.getCamera().z).toBeCloseTo(zoom, 6);
    expect(navigator.zoomPercent.get()).toBeNull();

    // A zoom of the reader's own says how far, against the page filling the width.
    navigator.zoomIn();
    expect(navigator.zoomPercent.get()).toBe(150);
    navigator.resetView();
    expect(navigator.zoomPercent.get()).toBeNull();
  });

  it("takes a zoom for the reader's only when they pinched, scrolled or pressed a key for it", async () => {
    const { editor, navigator, pages } = boardWithPages(3);
    const { director, cameraConstraints } = navigator;
    director.go({ kind: "page", pageId: pages[1].id }, { animate: false });
    const fitted = editor.getCamera();

    // tldraw putting the camera back itself as the layout settles: not the reader's zoom.
    editor.setCamera({ ...fitted, z: fitted.z * 1.3 });
    await settle();
    expect(director.zoomChoice.get()).toBeNull();
    expect(editor.getCamera().z).toBeCloseTo(cameraConstraints.getPageFitZoom(pages[1]), 6);

    // A pinch is.
    pinch(editor);
    editor.setCamera({ ...editor.getCamera(), z: fitted.z * 1.3 });
    await settle();
    expect(director.zoomChoice.get()).toBeCloseTo((fitted.z * 1.3) / cameraConstraints.getFitZoom(), 6);
  });
});
