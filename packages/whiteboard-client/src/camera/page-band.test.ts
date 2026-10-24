import { describe, expect, it } from "vitest";
import { WHITEBOARD_CONFIG } from "@orbmeet/whiteboard-core/config";
import {
  cameraFocusingBounds,
  findPageIndexAtY,
  fractionsToPageSpaceRect,
  pageSpaceRectToFractions,
  visibleBoundsForCamera,
  type PageExtent,
  type ScreenInsets,
  type ScreenSize,
} from "./page-band";

const { PAGE_WIDTH, PAGE_HEIGHT } = WHITEBOARD_CONFIG;

const NO_INSETS: ScreenInsets = { left: 0, right: 0, top: 0, bottom: 0 };
const PADDED: ScreenInsets = { left: 40, right: 40, top: 40, bottom: 40 };

const A4_PAGE: PageExtent = { y: 2000, height: 1697, width: PAGE_WIDTH };

function fitZoomFor(viewport: ScreenSize, insets: ScreenInsets): number {
  return (viewport.width - insets.left - insets.right) / PAGE_WIDTH;
}

describe("visibleBoundsForCamera ↔ cameraFocusingBounds", () => {
  it("re-applying a captured band preserves local zoom and focus center", () => {
    const viewport: ScreenSize = { width: 1440, height: 820 };
    const localZoom = fitZoomFor(viewport, PADDED);
    const camera = { x: -120, y: -2300, z: localZoom * 1.5 };

    const bounds = visibleBoundsForCamera(camera, viewport, PADDED);
    const focused = cameraFocusingBounds({
      bounds,
      viewport,
      insets: PADDED,
      zoom: localZoom,
    });

    const visible = visibleBoundsForCamera(focused, viewport, PADDED);
    expect(focused.z).toBeCloseTo(localZoom, 6);
    expect(visible.x + visible.w / 2).toBeCloseTo(bounds.x + bounds.w / 2, 6);
    expect(visible.y + visible.h / 2).toBeCloseTo(bounds.y + bounds.h / 2, 6);
  });

  it("fraction conversion round-trips through a page band", () => {
    const bounds = { x: 60, y: 2480, w: 1080, h: 600 };
    const fractions = pageSpaceRectToFractions(bounds, A4_PAGE);
    const back = fractionsToPageSpaceRect(fractions, A4_PAGE);
    expect(back.x).toBeCloseTo(bounds.x, 6);
    expect(back.y).toBeCloseTo(bounds.y, 6);
    expect(back.w).toBeCloseTo(bounds.w, 6);
    expect(back.h).toBeCloseTo(bounds.h, 6);
  });
});

describe("cameraFocusingBounds across devices", () => {
  // Presenter on a 16:9 laptop shows the bottom half of an A4 page.
  const presenterViewport: ScreenSize = { width: 1440, height: 810 };
  const presenterFit = fitZoomFor(presenterViewport, NO_INSETS);
  const presenterCamera = {
    x: 0,
    y: -(A4_PAGE.y + A4_PAGE.height) + 810 / presenterFit,
    z: presenterFit,
  };
  const band = visibleBoundsForCamera(presenterCamera, presenterViewport, NO_INSETS);

  it("portrait follower keeps its zoom while centering the presenter focus", () => {
    const follower: ScreenSize = { width: 820, height: 1100 };
    const followerFit = fitZoomFor(follower, NO_INSETS);
    const camera = cameraFocusingBounds({
      bounds: band,
      viewport: follower,
      insets: NO_INSETS,
      zoom: followerFit,
    });

    const followerVisible = visibleBoundsForCamera(camera, follower, NO_INSETS);
    expect(camera.z).toBeCloseTo(followerFit, 6);
    expect(followerVisible.x + followerVisible.w / 2).toBeCloseTo(
      band.x + band.w / 2,
      6
    );
    expect(followerVisible.y + followerVisible.h / 2).toBeCloseTo(
      band.y + band.h / 2,
      6
    );
  });

  it("does not zoom out to contain a tall presenter band", () => {
    const tallBounds = {
      x: 0,
      y: A4_PAGE.y,
      w: PAGE_WIDTH,
      h: A4_PAGE.height,
    };
    const follower: ScreenSize = { width: 1440, height: 700 };
    const followerFit = fitZoomFor(follower, NO_INSETS);
    const camera = cameraFocusingBounds({
      bounds: tallBounds,
      viewport: follower,
      insets: NO_INSETS,
      zoom: followerFit,
    });
    expect(camera.z).toBeCloseTo(followerFit, 6);

    const visible = visibleBoundsForCamera(camera, follower, NO_INSETS);
    expect(visible.y + visible.h / 2).toBeCloseTo(
      tallBounds.y + tallBounds.h / 2,
      4
    );
  });

  it("does not zoom in to match a tiny presenter band", () => {
    const tiny = { x: 590, y: 440, w: 8, h: 6 };
    const viewport: ScreenSize = { width: 1280, height: 800 };
    const fitZoom = fitZoomFor(viewport, NO_INSETS);
    const camera = cameraFocusingBounds({
      bounds: tiny,
      viewport,
      insets: NO_INSETS,
      zoom: fitZoom,
    });
    expect(camera.z).toBeCloseTo(fitZoom, 6);
  });

  it("respects asymmetric insets when centering", () => {
    const insets: ScreenInsets = { left: 16, right: 16, top: 104, bottom: 176 };
    const viewport: ScreenSize = { width: 390, height: 844 };
    const zoom = (viewport.width - 32) / PAGE_WIDTH;
    const bounds = { x: 0, y: 0, w: PAGE_WIDTH, h: PAGE_HEIGHT };
    const camera = cameraFocusingBounds({ bounds, viewport, insets, zoom });

    // The band center (not the raw viewport center) must land on the bounds
    // center: screenY of bounds center = top + bandH/2.
    const bandH = viewport.height - insets.top - insets.bottom;
    const screenY = (PAGE_HEIGHT / 2 + camera.y) * camera.z;
    expect(screenY).toBeCloseTo(insets.top + bandH / 2, 4);
  });
});

describe("findPageIndexAtY", () => {
  const pages = [
    { y: 0, height: 900 },
    { y: 940, height: 1697 },
    { y: 2677, height: 900 },
  ];

  it("returns the containing page", () => {
    expect(findPageIndexAtY(pages, 450)).toBe(0);
    expect(findPageIndexAtY(pages, 2000)).toBe(1);
    expect(findPageIndexAtY(pages, 3500)).toBe(2);
  });

  it("falls back to the nearest page center inside spacing gaps", () => {
    expect(findPageIndexAtY(pages, 920)).toBe(0);
    // Nearest *center* decides, so the gap below a tall page can resolve to
    // the shorter page after it — same semantics as PageManager's fallback.
    expect(findPageIndexAtY(pages, 2660)).toBe(2);
  });

  it("returns -1 for an empty list", () => {
    expect(findPageIndexAtY([], 100)).toBe(-1);
  });
});
