import { Box, type Editor, type TLCamera } from "tldraw";
import { WHITEBOARD_CONFIG } from "@orbmeet/whiteboard-core/config";
import type { WhiteboardPage } from "../pages/page-manager";
import { AUTO_ADD_PAGE_PULL_DISTANCE_PX, isNearFitWidthZoom } from "../pages/pull-to-add";
import {
  cameraFocusingBounds,
  findPageIndexAtY,
  fractionsToPageSpaceRect,
  pageSpaceRectToFractions,
  visibleBoundsForCamera,
  type PageBand,
  type PageSpaceRect,
} from "./page-band";
import {
  getFitRelativeZoom,
  getFitWidthZoom,
  getWhiteboardViewportInsets,
} from "./viewport-model";
import {
  DEFAULT_WHITEBOARD_CHROME,
  type WhiteboardChromeConfig,
} from "../chrome/whiteboard-chrome";

export { WHITEBOARD_PHONE_PORTRAIT_INSETS } from "./viewport-insets";

const { PAGE_WIDTH, PAGE_HEIGHT, PAGE_SPACING, CAMERA_PADDING, ZOOM_STEPS } =
  WHITEBOARD_CONFIG;

/**
 * The widest a page is drawn at the fit, in screen pixels. Past this a page on
 * a very wide monitor reads as a poster: lines too long to follow, and so
 * tall that one page is all the screen holds.
 */
export const MAX_FIT_PAGE_SCREEN_WIDTH_PX = 1600;

/**
 * Past the last page, how far a reader who may add pages can pull before the
 * board stops: the pull-to-add distance plus a little room for the indicator.
 */
const PULL_TO_ADD_ROOM_PX = AUTO_ADD_PAGE_PULL_DISTANCE_PX + 48;

/**
 * The least zoom tldraw allows, against the page filling the board's width:
 * below the reader's own zoom steps, so a follower can be shown a tall page
 * (a PDF page) whole on a short board.
 */
const MIN_ZOOM_STEP = 0.25;

export interface VisibleBand {
  page: WhiteboardPage;
  rect: PageBand;
  /** The same band in absolute page-space coordinates. */
  bounds: PageSpaceRect;
}

interface ViewportInsets {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface CameraDimensions {
  pageWidth: number;
  pageHeight: number;
  pageSpacing: number;
  cameraPadding: number;
}

type CameraPoint = Pick<TLCamera, "x" | "y" | "z">;

function isUsableCamera(camera: CameraPoint): boolean {
  return (
    Number.isFinite(camera.x) &&
    Number.isFinite(camera.y) &&
    Number.isFinite(camera.z) &&
    camera.z > 0
  );
}

/**
 * The camera rules for a board that scrolls like a notebook.
 *
 * Pages are one vertical stack and the camera moves over it freely: a
 * scroll, a drag or a pinch goes exactly where the hand takes it, and letting
 * go leaves it there — the end of one page and the start of the next stay on
 * screen together for as long as the reader wants them.
 *
 * Only the edges are held, and they are held before a move is committed
 * (`install`), so the board never draws a frame out of bounds and then jumps
 * back:
 *
 * - across, the page sits between the chrome's side bands — centred on the
 *   board when there is room, nudged off the palette when not — and only
 *   pans sideways once it is zoomed wider than the space between them;
 * - down, page 1's top stops at the top band and the last page's bottom at
 *   the bottom band, with room past it to pull for a new page.
 *
 * The fit is the page filling the width between the bands (never wider than
 * `MAX_FIT_PAGE_SCREEN_WIDTH_PX`). It is what "100%" means.
 *
 * Geometry only: it works out cameras and holds the edges, and never moves
 * the camera on its own. `CameraDirector` decides where the board goes.
 */
export class CameraConstraints {
  private dimensions: CameraDimensions;
  private _canAutoCreate = false;
  /** The pages the bounds were last computed for; read on every camera change. */
  private pages: readonly WhiteboardPage[] = [];

  constructor(
    private editor: Editor,
    dimensions?: CameraDimensions,
    private chrome: WhiteboardChromeConfig = DEFAULT_WHITEBOARD_CHROME
  ) {
    this.dimensions = dimensions ?? {
      pageWidth: PAGE_WIDTH,
      pageHeight: PAGE_HEIGHT,
      pageSpacing: PAGE_SPACING,
      cameraPadding: CAMERA_PADDING,
    };
  }

  /** The breathing room around a page, which differs between phones, tablets and desktops. */
  setCameraPadding(cameraPadding: number) {
    this.dimensions = { ...this.dimensions, cameraPadding };
  }

  updateChrome(chrome: WhiteboardChromeConfig) {
    this.chrome = chrome;
  }


  setCanAutoCreate(value: boolean) {
    this._canAutoCreate = value;
  }

  /**
   * Hold every camera change inside the board's edges, before it is
   * committed. Returns the uninstaller.
   */
  install(): () => void {
    return this.editor.sideEffects.registerBeforeChangeHandler("camera", (_prev, next) => {
      const held = this.constrain(next);
      return held.x === next.x && held.y === next.y ? next : { ...next, x: held.x, y: held.y };
    });
  }

  private getFullDocumentBounds(pages: readonly WhiteboardPage[]): Box {
    if (pages.length === 0) {
      return new Box(0, 0, this.dimensions.pageWidth, this.dimensions.pageHeight);
    }
    const first = pages[0];
    const last = pages[pages.length - 1];
    return new Box(0, first.y, this.dimensions.pageWidth, last.y + last.height - first.y);
  }

  update(pages: readonly WhiteboardPage[]) {
    this.pages = pages;
    const insets = this.getViewportInsets();
    this.editor.setCameraOptions({
      constraints: {
        // tldraw keeps these for its zoom: the base zoom every zoom step is
        // relative to is the page's width between the mean of the side bands.
        // Where the camera may go is ours (`constrain`), so both axes are free.
        bounds: this.getFullDocumentBounds(pages),
        padding: { x: (insets.left + insets.right) / 2, y: insets.top },
        origin: { x: 0.5, y: 0 },
        initialZoom: "fit-x",
        baseZoom: "fit-x",
        behavior: { x: "free", y: "free" },
      },
      wheelBehavior: "pan",
      zoomSteps: [MIN_ZOOM_STEP, ...ZOOM_STEPS],
    });
  }

  getFillWidthZoom(): number {
    const viewport = this.editor.getViewportScreenBounds();
    return getFitWidthZoom(
      { width: viewport.width, height: viewport.height },
      {
        pageWidth: this.dimensions.pageWidth,
        cameraPadding: this.dimensions.cameraPadding,
      },
      this.getViewportInsets(),
    );
  }

  /**
   * The fit: the page filling the width between the side bands, no wider
   * than `MAX_FIT_PAGE_SCREEN_WIDTH_PX`, and never below the reader's least
   * zoom step (`ZOOM_STEPS[0]` of the page filling the width).
   */
  getFitZoom(): number {
    const fillWidth = this.getFillWidthZoom();
    const capped = Math.min(fillWidth, MAX_FIT_PAGE_SCREEN_WIDTH_PX / this.dimensions.pageWidth);
    return Math.max(fillWidth * ZOOM_STEPS[0], capped);
  }

  /**
   * How this device reads `page` before anyone zooms: a wide page (a slide,
   * the default 16:9 page) whole, a tall one (a PDF page) across its width,
   * read by scrolling. A PDF viewer's "automatic" zoom, and the zoom every
   * reader's own zoom is relative to. Never wider than the fit.
   */
  getPageFitZoom(page: Pick<WhiteboardPage, "height"> | null | undefined): number {
    const fit = this.getFitZoom();
    if (!page || !(page.height > 0) || page.height > this.dimensions.pageWidth) return fit;
    const whole = this.getVisibleBandSize(1).h / page.height;
    return Math.max(fit * ZOOM_STEPS[0], Math.min(fit, whole));
  }

  /**
   * The zoom that shows all of `page` on this board: its fit, or less where
   * the page is taller than the board shows at the fit (a PDF page). What a
   * follower is shown.
   */
  getWholePageZoom(page: Pick<WhiteboardPage, "height"> | null | undefined): number {
    const fit = this.getPageFitZoom(page);
    if (!page || !(page.height > 0)) return fit;
    const whole = this.getVisibleBandSize(1).h / page.height;
    return Math.max(this.getFillWidthZoom() * MIN_ZOOM_STEP, Math.min(fit, whole));
  }

  /** The size, in page units, of the part of the board a reader sees at `zoom`: the board less its bands. */
  getVisibleBandSize(zoom: number): { w: number; h: number } {
    const viewport = this.editor.getViewportScreenBounds();
    const insets = this.getViewportInsets();
    return {
      w: Math.max(1, viewport.width - insets.left - insets.right) / zoom,
      h: Math.max(1, viewport.height - insets.top - insets.bottom) / zoom,
    };
  }

  /** Camera zoom expressed relative to the fit. */
  getFitRelativeZoom(): number {
    return getFitRelativeZoom(this.editor.getCamera().z, this.getFitZoom());
  }

  isNearFitXZoom(): boolean {
    return isNearFitWidthZoom(this.editor.getCamera().z, this.getFitZoom());
  }

  private getViewportInsets(): ViewportInsets {
    return getWhiteboardViewportInsets(
      {
        pageWidth: this.dimensions.pageWidth,
        cameraPadding: this.dimensions.cameraPadding,
      },
      this.chrome
    );
  }

  /**
   * The chrome-adjusted portion of the viewport in absolute page space.
   * Consumers should use this instead of the raw tldraw viewport whenever
   * "what the user can see" is the relevant coordinate system.
   */
  getVisibleViewportBounds(): PageSpaceRect | null {
    const camera = this.editor.getCamera();
    if (!isUsableCamera(camera)) return null;
    const viewport = this.editor.getViewportScreenBounds();
    return visibleBoundsForCamera(
      camera,
      { width: viewport.width, height: viewport.height },
      this.getViewportInsets(),
    );
  }

  getVisibleViewportCenter(): { x: number; y: number } | null {
    const bounds = this.getVisibleViewportBounds();
    return bounds
      ? { x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2 }
      : null;
  }

  /**
   * Camera X for the page at `zoom`: centred on the board when that keeps it
   * clear of both side bands, otherwise as near the centre as the bands
   * allow. Null when the page is wider than the space between the bands —
   * zoomed in — where it may be panned instead.
   */
  private getRestCameraX(zoom: number): number | null {
    const viewport = this.editor.getViewportScreenBounds();
    const insets = this.getViewportInsets();
    const pageScreenWidth = this.dimensions.pageWidth * zoom;
    const lowest = insets.left;
    const highest = viewport.width - insets.right - pageScreenWidth;
    if (highest < lowest) return null;
    const centred = (viewport.width - pageScreenWidth) / 2;
    return Math.min(highest, Math.max(lowest, centred)) / zoom;
  }

  /**
   * Where the camera may be: the camera asked for, held inside the board's
   * edges (see the class comment). Pure; `install` applies it to every move.
   *
   * `pullRoom: false` leaves out the room past the last page that someone who
   * may add pages can pull into: where the camera belongs at rest.
   */
  constrain<T extends CameraPoint>(camera: T, { pullRoom = true }: { pullRoom?: boolean } = {}): CameraPoint {
    const { pages } = this;
    if (!isUsableCamera(camera) || pages.length === 0) return camera;
    const z = camera.z;
    const viewport = this.editor.getViewportScreenBounds();
    const insets = this.getViewportInsets();

    let x = this.getRestCameraX(z);
    if (x === null) {
      const pageScreenWidth = this.dimensions.pageWidth * z;
      const lowest = (viewport.width - insets.right - pageScreenWidth) / z;
      const highest = insets.left / z;
      x = Math.min(highest, Math.max(lowest, camera.x));
    }

    const first = pages[0];
    const last = pages[pages.length - 1];
    const bandHeight = Math.max(1, viewport.height - insets.top - insets.bottom) / z;
    // Page 1's top no lower than the top band.
    const highestY = insets.top / z - first.y;
    // The last page's bottom no higher than the bottom band, except that its
    // top may always reach the top band, where going to it puts it: a page
    // shorter than the band would otherwise be pushed down to the bottom, with
    // the page before it showing above. Someone who may add pages can pull
    // further, far enough past it to pull for one; pull-to-add arms only past
    // that top.
    const resting = Math.max(0, bandHeight - last.height);
    const trailing = this._canAutoCreate && pullRoom
      ? Math.max(PULL_TO_ADD_ROOM_PX / z, bandHeight - last.height + 48 / z)
      : resting;
    const lowestY = Math.min(
      highestY,
      (viewport.height - insets.bottom) / z - (last.y + last.height + trailing),
    );
    const y = Math.min(highestY, Math.max(lowestY, camera.y));
    return { x, y, z };
  }

  /**
   * Whether `camera` is in the pull room past the last page: where someone
   * who may add pages can pull to, but not where a view should rest.
   */
  isInPullRoom(camera: CameraPoint): boolean {
    if (!this._canAutoCreate || !isUsableCamera(camera)) return false;
    const rest = this.constrain(camera, { pullRoom: false });
    return Math.abs(rest.y - camera.y) * camera.z >= 0.5;
  }

  /** The camera that shows `page` from its top, at `zoom`, held inside the board. */
  cameraAtPageTop(page: WhiteboardPage, zoom: number): CameraPoint {
    const insets = this.getViewportInsets();
    const x = this.getRestCameraX(zoom) ?? insets.left / zoom;
    return this.constrain({ x, y: insets.top / zoom - page.y, z: zoom }, { pullRoom: false });
  }

  /** The band `camera` shows, anchored to the page under its middle. */
  getVisibleBandFor(camera: CameraPoint, pages: readonly WhiteboardPage[]): VisibleBand | null {
    if (pages.length === 0 || !isUsableCamera(camera)) return null;
    const viewport = this.editor.getViewportScreenBounds();
    const bounds = visibleBoundsForCamera(
      camera,
      { width: viewport.width, height: viewport.height },
      this.getViewportInsets(),
    );

    const pageIndex = findPageIndexAtY(pages, bounds.y + bounds.h / 2);
    if (pageIndex < 0) return null;
    const page = pages[pageIndex];

    return {
      page,
      bounds,
      rect: pageSpaceRectToFractions(bounds, {
        y: page.y,
        height: page.height,
        width: this.dimensions.pageWidth,
      }),
    };
  }

  /**
   * The camera that puts a page-space point at the middle of this device's
   * visible band, at `zoom` (this viewer's own, unless given).
   */
  cameraCentring(
    point: { x: number; y: number },
    zoom = this.editor.getCamera().z,
  ): CameraPoint {
    const viewport = this.editor.getViewportScreenBounds();
    return cameraFocusingBounds({
      bounds: { x: point.x, y: point.y, w: 0, h: 0 },
      viewport: { width: viewport.width, height: viewport.height },
      insets: this.getViewportInsets(),
      zoom,
    });
  }

  /** The page-space point at the middle of the visible band under `camera`. */
  visibleCentreFor(camera: CameraPoint): { x: number; y: number } {
    const viewport = this.editor.getViewportScreenBounds();
    const insets = this.getViewportInsets();
    const bandW = Math.max(1, viewport.width - insets.left - insets.right);
    const bandH = Math.max(1, viewport.height - insets.top - insets.bottom);
    return {
      x: (insets.left + bandW / 2) / camera.z - camera.x,
      y: (insets.top + bandH / 2) / camera.z - camera.y,
    };
  }

  /**
   * The camera that keeps what was at the top of the view at the top, after
   * the board changed size: the band's top edge stays put and its middle
   * stays centred across, at `zoom`, held inside the board and never in the
   * pull room. A document does this when its window resizes; centring the
   * old middle instead cut the top of the page off whenever the board grew.
   */
  cameraKeepingBand(page: WhiteboardPage, rect: PageBand, zoom: number): CameraPoint {
    const bounds = fractionsToPageSpaceRect(rect, {
      y: page.y,
      height: page.height,
      width: this.dimensions.pageWidth,
    });
    const viewport = this.editor.getViewportScreenBounds();
    const insets = this.getViewportInsets();
    const bandWidth = Math.max(1, viewport.width - insets.left - insets.right);
    return this.constrain(
      {
        x: (insets.left + bandWidth / 2) / zoom - (bounds.x + bounds.w / 2),
        y: insets.top / zoom - bounds.y,
        z: zoom,
      },
      { pullRoom: false },
    );
  }
}
