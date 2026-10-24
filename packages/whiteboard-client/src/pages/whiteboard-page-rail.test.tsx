import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { WhiteboardPageRail } from "./whiteboard-page-rail";
import type { WhiteboardPage } from "./page-manager";
import {
  WHITEBOARD_PAGE_RAIL_CARD_WIDTH_PX,
  WHITEBOARD_PAGE_RAIL_WIDTH_PX,
} from "../camera/viewport-insets";

function makePages(count: number): WhiteboardPage[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `shape:page-${index + 1}` as never,
    number: index + 1,
    y: index * 900,
    height: 900,
    width: 1200,
  }));
}

const baseProps = {
  pages: makePages(3),
  currentPage: 2,
  canAddPages: true,
  onPageChange: vi.fn(),
  onAddPage: vi.fn(),
  onInsertPageAfter: vi.fn(),
};

describe("WhiteboardPageRail", () => {
  it("names the foot button for what it does — append, not insert", () => {
    const markup = renderToStaticMarkup(<WhiteboardPageRail {...baseProps} />);
    expect(markup).toContain('aria-label="Add page at end"');
  });

  it("offers an insert caret in every gap between pages", () => {
    const markup = renderToStaticMarkup(<WhiteboardPageRail {...baseProps} />);
    expect(markup).toContain('aria-label="Insert page after page 1"');
    expect(markup).toContain('aria-label="Insert page after page 2"');
  });

  it("offers the position above page 1, which had no control at all", () => {
    // The rail could express "after page n" for every n and nothing else, so
    // the top of the document was the one place a page could not be put — and
    // the client clamped `afterPageNumber` to 1 to match, even though the
    // server has always accepted 0.
    const markup = renderToStaticMarkup(<WhiteboardPageRail {...baseProps} />);
    expect(markup).toContain('aria-label="Insert page before page 1"');
    expect(markup).toContain('data-insert-after="0"');
  });

  it("draws no caret below the last page, where insert and append coincide", () => {
    const markup = renderToStaticMarkup(<WhiteboardPageRail {...baseProps} />);
    expect(markup).not.toContain('aria-label="Insert page after page 3"');
  });

  it("drops the carets when the caller cannot place pages", () => {
    const markup = renderToStaticMarkup(
      <WhiteboardPageRail {...baseProps} onInsertPageAfter={undefined} />,
    );
    expect(markup).not.toContain("Insert page after");
    expect(markup).toContain('aria-label="Add page at end"');
  });

  it("shows no add affordance at all without permission", () => {
    const markup = renderToStaticMarkup(
      <WhiteboardPageRail {...baseProps} canAddPages={false} />,
    );
    expect(markup).not.toContain("Insert page after");
    expect(markup).not.toContain("Add page at end");
  });

  it("disables both affordances while an add is in flight", () => {
    const markup = renderToStaticMarkup(
      <WhiteboardPageRail {...baseProps} isAddingPage />,
    );
    // Three gaps that can take a page — above 1, after 1, after 2 — plus the
    // append button at the foot.
    expect(markup.match(/disabled=""/g) ?? []).toHaveLength(4);
  });
});

describe("WhiteboardPageRail page menu", () => {
  it("marks the current card as opening a menu rather than navigating", () => {
    // The rail's second gesture. A tap on any other card goes to that page; a
    // tap on the one you are standing on has nowhere to navigate to, so it is
    // free to mean something else — which is what makes page actions reachable
    // with a finger, on a device that has no hover state to hide them behind.
    const markup = renderToStaticMarkup(
      <WhiteboardPageRail {...baseProps} canDeletePages onDeletePage={vi.fn()} />,
    );
    expect(markup).toContain(
      'aria-label="Page 2, current page. Open page actions"',
    );
    expect(markup).toContain('aria-haspopup="menu"');
    // Every other card keeps the plain, unqualified meaning.
    expect(markup).toContain('aria-label="Go to page 1"');
    expect(markup).toContain('aria-label="Go to page 3"');
  });

  it("leaves the current card a plain link when there is nothing to offer", () => {
    const markup = renderToStaticMarkup(
      <WhiteboardPageRail
        {...baseProps}
        canAddPages={false}
        onInsertPageAfter={undefined}
      />,
    );
    expect(markup).toContain('aria-label="Go to page 2"');
    expect(markup).not.toContain('aria-haspopup="menu"');
  });
});

describe("rail geometry", () => {
  it("sizes a card to the width the thumbnail renderer rasterises for", () => {
    // These are two literals in two modules, and they have to be the same
    // number: `use-page-thumbnails` solves `pixelRatio` from the card width,
    // so a card wider than the raster is a permanently upscaled thumbnail —
    // which is exactly the bug that shipped when the raster was solved for 64
    // CSS pixels and then displayed on a 2x screen.
    const markup = renderToStaticMarkup(<WhiteboardPageRail {...baseProps} />);
    expect(WHITEBOARD_PAGE_RAIL_CARD_WIDTH_PX).toBe(88);
    expect(WHITEBOARD_PAGE_RAIL_CARD_WIDTH_PX).toBeLessThan(
      WHITEBOARD_PAGE_RAIL_WIDTH_PX,
    );
    expect(markup).toContain('aria-label="Pages"');
  });
});
