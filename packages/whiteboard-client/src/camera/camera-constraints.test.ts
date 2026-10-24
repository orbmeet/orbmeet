import { describe, expect, it, vi } from "vitest";
import type { Editor } from "tldraw";
import {
  CameraConstraints,
  MAX_FIT_PAGE_SCREEN_WIDTH_PX,
  WHITEBOARD_PHONE_PORTRAIT_INSETS,
} from "./camera-constraints";
import { AUTO_ADD_PAGE_PULL_DISTANCE_PX } from "../pages/pull-to-add";
import {
  WHITEBOARD_CONTROLS_BAND_PX,
  WHITEBOARD_EDGE_INSET_PX,
  WHITEBOARD_PALETTE_BAND_PX,
  WHITEBOARD_TOOLBAR_HEIGHT,
} from "./viewport-insets";
import type { WhiteboardChromeConfig } from "../chrome/whiteboard-chrome";
import type { WhiteboardPage } from "../pages/page-manager";

/** A writer's regular board: the palette's band on the left, the edge gap elsewhere. */
const LEFT = WHITEBOARD_PALETTE_BAND_PX;
const RIGHT = WHITEBOARD_EDGE_INSET_PX;
const TOP = WHITEBOARD_CONTROLS_BAND_PX;
const BOTTOM = WHITEBOARD_EDGE_INSET_PX;

const READER: WhiteboardChromeConfig = {
  mode: "regular",
  toolbarVisible: false,
  isMeetingPhonePortrait: false,
  pageRailVisible: false,
  sideways: false,
};

/** A phone held upright: compact chrome, its tool strip across the top. */
const PHONE: WhiteboardChromeConfig = {
  mode: "compact",
  toolbarVisible: true,
  isMeetingPhonePortrait: false,
  pageRailVisible: false,
  sideways: false,
};

const DIMENSIONS = { pageWidth: 1200, pageHeight: 675, pageSpacing: 40, cameraPadding: 40 };

function createEditorMock(width: number, height: number) {
  let camera = { x: 0, y: 0, z: 1 };
  const editor = {
    getViewportScreenBounds: vi.fn(() => ({ x: 0, y: 0, width, height, w: width, h: height })),
    getCamera: vi.fn(() => camera),
    pageToScreen: vi.fn((point: { x: number; y: number }) => ({
      x: (point.x + camera.x) * camera.z,
      y: (point.y + camera.y) * camera.z,
    })),
    setCameraOptions: vi.fn(),
    setCamera: vi.fn((nextCamera: typeof camera) => {
      camera = nextCamera;
    }),
  } as unknown as Editor & {
    setCamera: ReturnType<typeof vi.fn>;
    setCameraOptions: ReturnType<typeof vi.fn>;
  };
  return editor;
}

function makePages(count: number, height = 675, spacing = 40): WhiteboardPage[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `shape:page-${index + 1}` as never,
    number: index + 1,
    y: index * (height + spacing),
    height,
    width: 1200,
  }));
}

/** Put the camera where `pageNumber` lands: its top at the top band, at the fit. */
function landOnPage(
  editor: ReturnType<typeof createEditorMock>,
  constraints: CameraConstraints,
  pages: WhiteboardPage[],
  pageNumber: number,
) {
  constraints.update(pages);
  editor.setCamera(constraints.cameraAtPageTop(pages[pageNumber - 1], constraints.getFitZoom()));
}

/** The last camera set. */
function lastCamera(editor: ReturnType<typeof createEditorMock>) {
  return editor.setCamera.mock.calls.at(-1)![0] as { x: number; y: number; z: number };
}

/** Where a camera puts a page-space point on screen. */
function toScreen(camera: { x: number; y: number; z: number }, x: number, y: number) {
  return { x: (x + camera.x) * camera.z, y: (y + camera.y) * camera.z };
}

describe("CameraConstraints: where a page lands", () => {
  it("exposes the chrome-adjusted viewport in page coordinates", () => {
    const editor = createEditorMock(1600, 900);
    editor.setCamera({ x: 10, y: 20, z: 2 });
    const constraints = new CameraConstraints(editor, DIMENSIONS);

    const width = (1600 - LEFT - RIGHT) / 2;
    const height = (900 - TOP - BOTTOM) / 2;
    expect(constraints.getVisibleViewportBounds()).toEqual({
      x: -10 + LEFT / 2,
      y: -20 + TOP / 2,
      w: width,
      h: height,
    });
  });

  it("fills the width between the bands and lands a page with its top at the top band", () => {
    const editor = createEditorMock(1440, 764);
    const constraints = new CameraConstraints(editor, DIMENSIONS);

    landOnPage(editor, constraints, makePages(3), 2);

    const camera = lastCamera(editor);
    expect(camera.z).toBeCloseTo((1440 - LEFT - RIGHT) / 1200, 4);
    expect(toScreen(camera, 0, 715).x).toBeCloseTo(LEFT, 2);
    expect(toScreen(camera, 1200, 715).x).toBeCloseTo(1440 - RIGHT, 2);
    expect(toScreen(camera, 0, 715).y).toBeCloseTo(TOP, 2);
  });

  it("caps the fit on a very wide board, and centres the page there", () => {
    const editor = createEditorMock(3000, 1600);
    const constraints = new CameraConstraints(editor, DIMENSIONS);

    landOnPage(editor, constraints, makePages(1), 1);

    const camera = lastCamera(editor);
    expect(camera.z).toBeCloseTo(MAX_FIT_PAGE_SCREEN_WIDTH_PX / 1200, 4);
    const left = toScreen(camera, 0, 0).x;
    const right = toScreen(camera, 1200, 0).x;
    expect((left + right) / 2).toBeCloseTo(1500, 2);
  });

  it("keeps a reader's top band for the edit-access request and gives the palette's band back", () => {
    const editor = createEditorMock(760, 587);
    const constraints = new CameraConstraints(editor, DIMENSIONS, READER);

    landOnPage(editor, constraints, makePages(1), 1);

    const camera = lastCamera(editor);
    expect(camera.z).toBeCloseTo((760 - RIGHT * 2) / 1200, 4);
    expect(toScreen(camera, 0, 0).x).toBeCloseTo(RIGHT, 2);
    expect(toScreen(camera, 0, 0).y).toBeCloseTo(Math.max(WHITEBOARD_CONTROLS_BAND_PX, WHITEBOARD_TOOLBAR_HEIGHT.regular), 2);
  });

  it("fits the page to width on phone portrait so it never scrolls sideways", () => {
    const editor = createEditorMock(393, 852);
    const constraints = new CameraConstraints(editor, { ...DIMENSIONS, cameraPadding: 16 }, PHONE);

    landOnPage(editor, constraints, makePages(1), 1);

    expect(lastCamera(editor).z).toBeCloseTo((393 - 32) / 1200, 4);
  });

  // The meeting's side column narrows a desktop board under the width of a
  // phone, and the faces under it shorten one under a phone's height on its
  // side. Neither turns it into a phone: the palette and the top band stay.
  it("keeps a desktop board's page clear of its palette however narrow or short the board", () => {
    for (const [width, height] of [[620, 700], [1000, 430]]) {
      const editor = createEditorMock(width, height);
      const constraints = new CameraConstraints(editor, DIMENSIONS);

      landOnPage(editor, constraints, makePages(1), 1);

      const pageLeft = toScreen(lastCamera(editor), 0, 0).x;
      expect(pageLeft).toBeGreaterThanOrEqual(LEFT - 0.01);
      expect(toScreen(lastCamera(editor), 0, 0).y).toBeGreaterThanOrEqual(TOP - 0.01);
    }
  });

  it("lands under the tool strip on an upright tablet with compact chrome", () => {
    const editor = createEditorMock(820, 1180);
    const constraints = new CameraConstraints(
      editor,
      { ...DIMENSIONS, cameraPadding: 30 },
      { mode: "compact", toolbarVisible: true, isMeetingPhonePortrait: false, pageRailVisible: false, sideways: false },
    );

    landOnPage(editor, constraints, makePages(1), 1);

    const camera = lastCamera(editor);
    expect(camera.z).toBeCloseTo((820 - 32) / 1200, 4);
    expect(toScreen(camera, 0, 0).y).toBeCloseTo(30 + WHITEBOARD_TOOLBAR_HEIGHT.compact, 2);
  });
});

describe("CameraConstraints: holding the edges", () => {
  function boardWith(pages: WhiteboardPage[], width = 1024, height = 587) {
    const editor = createEditorMock(width, height);
    const constraints = new CameraConstraints(editor, DIMENSIONS);
    constraints.update(pages);
    return { editor, constraints, fit: constraints.getFitZoom() };
  }

  it("leaves a view between two pages exactly where it is", () => {
    const pages = makePages(3);
    const { constraints, fit } = boardWith(pages);
    // The end of page 1 and the top of page 2 in the middle of the board.
    const seam = constraints.cameraCentring({ x: 600, y: 675 + 20 }, fit);

    const held = constraints.constrain(seam);
    expect(held.x).toBeCloseTo(seam.x, 6);
    expect(held.y).toBeCloseTo(seam.y, 6);
  });

  it("holds the page across where it belongs", () => {
    const pages = makePages(3);
    const { constraints, fit } = boardWith(pages);
    const held = constraints.constrain({ x: 400, y: -300, z: fit });

    expect(held.x).toBeCloseTo(LEFT / fit, 4);
    expect(held.y).toBe(-300);
  });

  it("lets a zoomed-in page pan only as far as its edges", () => {
    const pages = makePages(3);
    const { constraints, fit } = boardWith(pages);
    const z = fit * 2;

    expect(constraints.constrain({ x: 500, y: -300, z }).x).toBeCloseTo(LEFT / z, 4);
    expect(constraints.constrain({ x: -5000, y: -300, z }).x).toBeCloseTo((1024 - RIGHT) / z - 1200, 4);
    expect(constraints.constrain({ x: -300, y: -300, z }).x).toBe(-300);
  });

  it("stops page 1's top at the top band", () => {
    const pages = makePages(3);
    const { constraints, fit } = boardWith(pages);

    expect(constraints.constrain({ x: 0, y: 400, z: fit }).y).toBeCloseTo(TOP / fit, 4);
  });

  it("stops the last page's bottom at the bottom band, or past it for someone who can add pages", () => {
    const pages = makePages(3);
    const { constraints, fit } = boardWith(pages);
    const lastBottom = 2 * 715 + 675;

    const held = constraints.constrain({ x: 0, y: -100_000, z: fit });
    expect(toScreen(held, 0, lastBottom).y).toBeCloseTo(587 - BOTTOM, 2);

    constraints.setCanAutoCreate(true);
    const pulled = constraints.constrain({ x: 0, y: -100_000, z: fit });
    expect(toScreen(pulled, 0, lastBottom).y).toBeLessThan(587 - BOTTOM - AUTO_ADD_PAGE_PULL_DISTANCE_PX);
  });

  it("springs a view left in the pull room back to the last page, and nothing else", () => {
    const pages = makePages(3);
    const { constraints, fit } = boardWith(pages);
    constraints.setCanAutoCreate(true);
    const lastBottom = 2 * 715 + 675;

    const pulled = constraints.constrain({ x: 0, y: -100_000, z: fit });
    expect(constraints.isInPullRoom(pulled)).toBe(true);
    const back = constraints.constrain(pulled, { pullRoom: false });
    expect(toScreen(back, 0, lastBottom).y).toBeCloseTo(587 - BOTTOM, 2);

    expect(constraints.isInPullRoom(constraints.cameraCentring({ x: 600, y: 715 + 300 }, fit))).toBe(false);
  });

  it("lets the last page rest with its top at the top band when it is shorter than the band", () => {
    const pages = makePages(3);
    const { editor, constraints, fit } = boardWith(pages, 1024, 1400);
    constraints.setCanAutoCreate(true);

    landOnPage(editor, constraints, pages, 3);
    const landed = lastCamera(editor);
    expect(toScreen(landed, 0, pages[2].y).y).toBeCloseTo(TOP, 2);
    expect(constraints.constrain(landed)).toEqual(landed);
    expect(constraints.isInPullRoom(landed)).toBe(false);

    const pulled = constraints.constrain({ x: 0, y: -100_000, z: fit });
    expect(constraints.isInPullRoom(pulled)).toBe(true);
    expect(toScreen(constraints.constrain(pulled, { pullRoom: false }), 0, pages[2].y).y).toBeCloseTo(TOP, 2);
  });

  it("lets a reader who cannot add pages rest the last page at the top band too", () => {
    const pages = makePages(3);
    const { editor, constraints } = boardWith(pages, 1024, 1400);

    landOnPage(editor, constraints, pages, 3);
    const landed = lastCamera(editor);
    // Not pushed down to the bottom band, with page 2 showing above it.
    expect(toScreen(landed, 0, pages[2].y).y).toBeCloseTo(TOP, 2);
    expect(constraints.constrain(landed)).toEqual(landed);
  });

  it("keeps a document shorter than the board at its top", () => {
    const pages = makePages(1);
    const { constraints, fit } = boardWith(pages, 1024, 2000);

    expect(constraints.constrain({ x: 0, y: -500, z: fit }).y).toBeCloseTo(TOP / fit, 4);
  });

  it("holds nothing before it knows the pages", () => {
    const editor = createEditorMock(1024, 587);
    const constraints = new CameraConstraints(editor, DIMENSIONS);
    const camera = { x: 999, y: 999, z: 1 };

    expect(constraints.constrain(camera)).toEqual(camera);
  });
});

describe("CameraConstraints: the document and the camera", () => {
  it("gives tldraw the document for its zoom, and keeps where the camera goes its own", () => {
    const editor = createEditorMock(1600, 900);
    const constraints = new CameraConstraints(editor);

    constraints.update(makePages(1, 900, 100));

    expect(editor.setCameraOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        constraints: expect.objectContaining({
          bounds: expect.objectContaining({ x: 0, y: 0, w: 1200, h: 900 }),
          padding: { x: (LEFT + RIGHT) / 2, y: TOP },
          behavior: { x: "free", y: "free" },
          initialZoom: "fit-x",
          baseZoom: "fit-x",
        }),
        wheelBehavior: "pan",
      }),
    );
  });

  it("uses the top visible-band inset for tldraw's padding on a phone", () => {
    const editor = createEditorMock(393, 640);
    const constraints = new CameraConstraints(editor, { ...DIMENSIONS, cameraPadding: 16 }, PHONE);

    constraints.update(makePages(1));

    expect(editor.setCameraOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        constraints: expect.objectContaining({
          padding: {
            x: 16,
            y: WHITEBOARD_PHONE_PORTRAIT_INSETS.top + WHITEBOARD_TOOLBAR_HEIGHT.compact,
          },
        }),
      }),
    );
  });

  it("shows a follower the whole page: a tall page fitted to the board's height", () => {
    // A PDF page on a laptop: across its width it would scroll.
    const editor = createEditorMock(1300, 640);
    const constraints = new CameraConstraints(editor, DIMENSIONS);
    const band = constraints.getVisibleBandSize(1);

    const whole = constraints.getWholePageZoom({ height: 1697 });
    expect(whole).toBeLessThan(constraints.getPageFitZoom({ height: 1697 }));
    expect(1697 * whole).toBeCloseTo(band.h, 4);
    // A wide page is already whole at its fit.
    expect(constraints.getWholePageZoom({ height: 675 })).toBeCloseTo(constraints.getPageFitZoom({ height: 675 }), 6);
  });

  it("reads a wide page whole and a tall page across its width", () => {
    // A laptop's board: a 16:9 page at the width's fit would run past the bottom band.
    const editor = createEditorMock(1300, 640);
    const constraints = new CameraConstraints(editor, DIMENSIONS);
    const fit = constraints.getFitZoom();
    const band = constraints.getVisibleBandSize(1);

    const wide = constraints.getPageFitZoom({ height: 675 });
    expect(wide).toBeLessThan(fit);
    expect(675 * wide).toBeCloseTo(band.h, 4);
    expect(constraints.getPageFitZoom({ height: 1697 })).toBeCloseTo(fit, 6);
    // Never wider than the fit, however short the page.
    expect(constraints.getPageFitZoom({ height: 100 })).toBeCloseTo(fit, 6);
  });
});
