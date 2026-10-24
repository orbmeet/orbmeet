import type {
  Editor,
  TLShapeId,
  TLShapePartial,
} from "tldraw";
import { createShapeId } from "@tldraw/tlschema";
import { WHITEBOARD_CONFIG } from "@orbmeet/whiteboard-core/config";
import {
  comparePageFrames,
  getPageFrameHeight,
  getPageFrameNameForNumber,
  getPageFrameRenumberUpdates,
  getPageFrameShiftUpdates,
  INITIAL_PAGE_FRAME_ID,
  isPageFrameShape,
  planPageFrameInsertion,
  type PageFrameShape,
} from "@orbmeet/whiteboard-core/page-frame-model";
import {
  WHITEBOARD_PAGE_SHAPE_TYPE,
} from "@orbmeet/whiteboard-core/page-shape-schema";
import { DEFAULT_PAGE_BACKGROUND } from "@orbmeet/whiteboard-core/page-background";
import { computeCompactedFrameYs } from "@orbmeet/whiteboard-core/page-geometry";
import { withPageFrameMutationAllowance } from "../shapes/page/protect-page-frames";

const { PAGE_WIDTH, PAGE_HEIGHT, PAGE_SPACING, MAX_PAGES } = WHITEBOARD_CONFIG;

export interface WhiteboardPage {
  id: TLShapeId;
  number: number;
  y: number;
  height: number;
  /**
   * The frame's own width in page units. Page height already varies per frame
   * (an imported PDF brings its own), so the aspect a thumbnail must be drawn
   * at is only knowable from the frame — not from the manager's configured
   * page size, which is a *default* and is re-tuned per viewport.
   */
  width: number;
}

export interface PageDimensions {
  width: number;
  height: number;
  spacing: number;
}

export class PageManager {
  private dimensions: PageDimensions;

  constructor(
    private editor: Editor,
    dimensions?: PageDimensions,
    private getVisibleViewportBounds?: () => {
      x: number;
      y: number;
      w: number;
      h: number;
    } | null,
  ) {
    this.dimensions = dimensions ?? {
      width: PAGE_WIDTH,
      height: PAGE_HEIGHT,
      spacing: PAGE_SPACING,
    };
  }


  getViewportBounds(): { x: number; y: number; w: number; h: number } {
    return this.getVisibleViewportBounds?.() ?? this.editor.getViewportPageBounds();
  }

  getPages(): WhiteboardPage[] {
    const frames = this.editor
      .getCurrentPageShapes()
      .filter(isPageFrameShape)
      .sort(comparePageFrames);

    return frames.map((frame, index) => ({
      id: frame.id,
      number: index + 1,
      y: frame.y,
      height: getPageFrameHeight(frame) ?? this.dimensions.height,
      width: frame.props.w ?? this.dimensions.width,
    }));
  }


  getPageById(pageId: TLShapeId): WhiteboardPage | null {
    return this.getPages().find((page) => page.id === pageId) ?? null;
  }

  getPageByNumber(pageNumber: number): WhiteboardPage | null {
    const safePageNumber = Math.max(1, Math.trunc(pageNumber));
    return this.getPages()[safePageNumber - 1] ?? null;
  }

  createPage(): TLShapeId | null {
    return this.runPageFrameMutation(() => {
      const pages = this.getPages();

      if (pages.length >= MAX_PAGES) {
        console.warn(`[PageManager] Maximum page limit (${MAX_PAGES}) reached`);
        return null;
      }

      const pageNumber = pages.length + 1;
      const plan = planPageFrameInsertion(
        pages,
        pages.length,
        1,
        this.dimensions
      );
      if (plan.actualCount <= 0) return null;

      const preferredFrameId = pageNumber === 1 ? INITIAL_PAGE_FRAME_ID : createShapeId();
      const frameId = this.editor.getShape(preferredFrameId)
        ? createShapeId()
        : preferredFrameId;

      this.editor.createShape({
        id: frameId,
        type: WHITEBOARD_PAGE_SHAPE_TYPE,
        x: 0,
        y: plan.insertionY,
        props: {
          w: this.dimensions.width,
          h: this.dimensions.height,
          name: getPageFrameNameForNumber(pageNumber),
          background: DEFAULT_PAGE_BACKGROUND,
        },
      });

      return frameId;
    });
  }

  createPages(count: number): TLShapeId[] {
    const ids: TLShapeId[] = [];
    for (let i = 0; i < count; i++) {
      const id = this.createPage();
      if (!id) break;
      ids.push(id);
    }
    return ids;
  }

  applyImportedPageMetadata(pageId: TLShapeId, source: PageFrameShape): void {
    this.runPageFrameMutation(() => {
      const destination = this.editor.getShape(pageId);
      if (!destination || !isPageFrameShape(destination)) return;
      this.editor.updateShape({
        id: destination.id,
        type: destination.type,
        props: {
          w: source.props.w,
          h: source.props.h,
          name: source.props.name,
          background: source.props.background,
        },
      });
    });
  }

  initialize() {
    if (this.getPages().length === 0) {
      this.createPage();
    }
  }

  getCurrentPage(): number {
    const pages = this.getPages();
    if (pages.length === 0) return 1;

    const viewportBounds = this.getViewportBounds();
    const viewportTop = viewportBounds.y;
    const viewportBottom = viewportTop + viewportBounds.h;
    const viewportCenterY = viewportTop + viewportBounds.h / 2;

    // The page that fills the most of the view. When the view's middle fell in
    // the gap between pages, the nearest page *centre* decided, which on tall
    // pages is usually the next page: the counter said 3 over a screen that
    // was mostly page 2.
    let mostVisibleIdx = -1;
    let mostVisible = 0;
    for (let i = 0; i < pages.length; i += 1) {
      const pageTop = pages[i].y;
      const visible =
        Math.min(viewportBottom, pageTop + pages[i].height) - Math.max(viewportTop, pageTop);
      if (visible > mostVisible) {
        mostVisible = visible;
        mostVisibleIdx = i;
      }
    }
    if (mostVisibleIdx >= 0) return mostVisibleIdx + 1;

    let nearestIdx = 0;
    let nearestDist = Infinity;
    for (let i = 0; i < pages.length; i++) {
      const pageCenterY = pages[i].y + pages[i].height / 2;
      const dist = Math.abs(viewportCenterY - pageCenterY);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearestIdx = i;
      }
    }

    return nearestIdx + 1;
  }

  insertPagesAt(index: number, count: number): TLShapeId[] {
    return this.runPageFrameMutation(() => {
      const pages = this.getPages();
      const plan = planPageFrameInsertion(pages, index, count, this.dimensions);
      if (plan.actualCount <= 0) return [];

      const pageShiftUpdates = getPageFrameShiftUpdates(pages, plan);
      if (pageShiftUpdates.length > 0) {
        this.editor.updateShapes(pageShiftUpdates);
      }

      const ids: TLShapeId[] = [];
      for (let i = 0; i < plan.actualCount; i++) {
        // computeInsertionY measures the actual prior frame (custom heights from
        // PDF import included) and is the same formula the server uses, so client
        // and server inserts land identically — including when page 1 doesn't sit
        // exactly at y=0.
        const y =
          plan.insertionY + i * (this.dimensions.height + this.dimensions.spacing);

        const frameId = createShapeId();
        this.editor.createShape({
          id: frameId,
          type: WHITEBOARD_PAGE_SHAPE_TYPE,
          x: 0,
          y,
          props: {
            w: this.dimensions.width,
            h: this.dimensions.height,
            name: getPageFrameNameForNumber(plan.insertIndex + i + 1),
            background: DEFAULT_PAGE_BACKGROUND,
          },
        });
        ids.push(frameId);
      }

      this.renumberPages();
      return ids;
    });
  }

  compactPages() {
    return this.runPageFrameMutation(() => this.compactPagesImpl());
  }

  deletePage(pageId: TLShapeId): boolean {
    const pages = this.getPages();
    if (pages.length <= 1) return false;

    const pageToDelete = pages.find((p) => p.id === pageId);
    if (!pageToDelete) return false;

    return this.runPageFrameMutation(() => {
      const frame = this.editor.getShape(pageId);
      if (!frame || !isPageFrameShape(frame)) return false;

      // Delete the frame; everything on the page is its child and goes with it.
      this.editor.deleteShapes([pageId]);

      // Compact remaining pages to close the gap and renumber them.
      this.compactPagesImpl();

      return true;
    });
  }

  private runPageFrameMutation<T>(fn: () => T): T {
    return withPageFrameMutationAllowance(this.editor, () => {
      let result: T;
      this.editor.run(
        () => {
          result = fn();
        },
        { history: "ignore" }
      );
      return result!;
    });
  }

  private compactPagesImpl() {
    const pages = this.getPages();
    if (pages.length === 0) return;

    const compactedYs = computeCompactedFrameYs(pages, this.dimensions);
    const frameUpdates: TLShapePartial[] = [];
    pages.forEach((page, i) => {
      if (Math.abs(compactedYs[i] - page.y) <= 0.5) return;
      // A frame that vanished between getPages() and here just isn't moved;
      // the pages after it still keep the slot it held.
      const frame = this.editor.getShape(page.id);
      if (frame && isPageFrameShape(frame)) {
        frameUpdates.push({ id: page.id, type: frame.type, y: compactedYs[i] });
      }
    });

    if (frameUpdates.length > 0) {
      this.editor.updateShapes(frameUpdates);
    }

    this.renumberPages();
  }

  private renumberPages() {
    const pages = this.getPages();
    const updates: TLShapePartial[] = getPageFrameRenumberUpdates(
      pages.map((page) => {
        const frame = this.editor.getShape(page.id);
        return frame && isPageFrameShape(frame) ? frame : page;
      })
    );

    if (updates.length > 0) {
      this.editor.updateShapes(updates);
    }
  }

}
