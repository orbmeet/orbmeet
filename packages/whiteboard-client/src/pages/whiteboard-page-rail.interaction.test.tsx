// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as stylex from "@stylexjs/stylex";
import type { StyleXStyles } from "@stylexjs/stylex";
import { env } from "@orbmeet/ui/tokens/media.stylex";
import { WhiteboardPageRail } from "./whiteboard-page-rail";
import type { WhiteboardPage } from "./page-manager";
import { railVars } from "../styles/board-context.stylex";

afterEach(cleanup);

/**
 * How the card you are standing on names itself.
 *
 * A tap on any other card goes to that page. A tap on this one has nowhere to
 * navigate to, so it opens the page's own actions instead — which is what
 * makes insert and delete reachable with a finger on a device that has no
 * hover state to hide them behind.
 */
const CURRENT_CARD_LABEL = "Page 2, current page. Open page actions";

function makePages(count: number, idPrefix = "page"): WhiteboardPage[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `shape:${idPrefix}-${index + 1}` as never,
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

/** The rail's placeholder is decorative, so it carries a test hook, not a role. */
function pendingSlot(container: HTMLElement) {
  return container.querySelector("[data-pending-page]");
}

function enteringCards(container: HTMLElement) {
  return [...container.querySelectorAll("[data-entering-page]")].map(
    (card) => card.textContent,
  );
}

describe("WhiteboardPageRail placeholder", () => {
  it("holds a slot at the foot of the list while an append is in flight", () => {
    const { container, rerender } = render(<WhiteboardPageRail {...baseProps} />);
    expect(pendingSlot(container)).toBeNull();

    fireEvent.click(screen.getByLabelText("Add page at end"));
    rerender(<WhiteboardPageRail {...baseProps} isAddingPage />);

    const slot = pendingSlot(container);
    expect(slot).not.toBeNull();
    // After every page, because that is where the page will land.
    const last = screen.getByLabelText("Go to page 3");
    expect(last.compareDocumentPosition(slot!)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("holds the slot in the gap the insert caret named", () => {
    const { container, rerender } = render(<WhiteboardPageRail {...baseProps} />);

    fireEvent.click(screen.getByLabelText("Insert page after page 1"));
    rerender(<WhiteboardPageRail {...baseProps} isAddingPage />);

    const slot = pendingSlot(container);
    expect(slot).not.toBeNull();
    expect(
      screen.getByLabelText("Go to page 1").compareDocumentPosition(slot!),
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(
      screen.getByLabelText(CURRENT_CARD_LABEL).compareDocumentPosition(slot!),
    ).toBe(Node.DOCUMENT_POSITION_PRECEDING);
  });

  it("releases the slot once the request settles", () => {
    const { container, rerender } = render(<WhiteboardPageRail {...baseProps} />);
    fireEvent.click(screen.getByLabelText("Add page at end"));
    rerender(<WhiteboardPageRail {...baseProps} isAddingPage />);
    expect(pendingSlot(container)).not.toBeNull();

    // A failed add comes back with the page count unchanged; the promise the
    // placeholder was making has to go with it.
    rerender(<WhiteboardPageRail {...baseProps} isAddingPage={false} />);
    expect(pendingSlot(container)).toBeNull();
  });
});

describe("WhiteboardPageRail arrival", () => {
  it("does not animate the pages that were already there on first paint", () => {
    const { container } = render(<WhiteboardPageRail {...baseProps} />);
    expect(enteringCards(container)).toEqual([]);
  });

  it("animates only the page that arrived", () => {
    const { container, rerender } = render(<WhiteboardPageRail {...baseProps} />);
    rerender(<WhiteboardPageRail {...baseProps} pages={makePages(4)} />);
    expect(enteringCards(container)).toEqual(["4"]);
  });

  it("animates an inserted page rather than the pages it renumbered", () => {
    const pages = makePages(3);
    const inserted: WhiteboardPage[] = [
      pages[0],
      { ...pages[1], id: "shape:page-new" as never, number: 2 },
      { ...pages[1], number: 3 },
      { ...pages[2], number: 4 },
    ];
    const { container, rerender } = render(<WhiteboardPageRail {...baseProps} />);
    rerender(<WhiteboardPageRail {...baseProps} pages={inserted} />);
    // Page 2 is the new id; the old pages 2 and 3 merely became 3 and 4.
    expect(enteringCards(container)).toEqual(["2"]);
  });

  it("animates a page a collaborator added, not just a local one", () => {
    const { container, rerender } = render(
      <WhiteboardPageRail {...baseProps} canAddPages={false} />,
    );
    rerender(
      <WhiteboardPageRail {...baseProps} canAddPages={false} pages={makePages(4)} />,
    );
    expect(enteringCards(container)).toEqual(["4"]);
  });

  it("stops animating a page once its entry window has passed", () => {
    vi.useFakeTimers();
    try {
      const { container, rerender } = render(<WhiteboardPageRail {...baseProps} />);
      rerender(<WhiteboardPageRail {...baseProps} pages={makePages(4)} />);
      expect(enteringCards(container)).toEqual(["4"]);

      vi.advanceTimersByTime(2000);
      rerender(
        <WhiteboardPageRail {...baseProps} pages={makePages(4)} currentPage={4} />,
      );
      expect(enteringCards(container)).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * The declarations the contracts below are about, written the way the rail
 * writes them so they compile to the same classes. This asserts the
 * *declaration*, not StyleX's class naming.
 */
const marks = stylex.create({
  /**
   * A caret row's box: a fixed height per pointer type, and nothing that
   * changes on hover.
   *
   * Two heights, because the row has two jobs. A mouse reveals the caret under
   * the cursor and 14px is enough to aim at; touch has no cursor to reveal it
   * with, so the row is permanently visible and sized to be hit — the whole
   * reason "add a page between 4 and 5" was unanswerable on a tablet.
   */
  caretRow: { height: { default: 28, [env.hoverable]: 14 } },
  /** What the list used to publish: every caret in the document, at once. */
  listWideCaretReveal: {
    [railVars.caretOpacity]: {
      default: "0",
      [env.hoverable]: { default: "0", ":hover": "0.5" },
    },
  },
});

/** The px a dynamic `cardHeight(...)` resolved to, read off the inline style. */
function cardHeightPx(element: HTMLElement): number | null {
  const declarations = (element.getAttribute("style") ?? "").split(";");
  for (const declaration of declarations) {
    const [property, value] = declaration.split(":").map((part) => part.trim());
    if (!property?.startsWith("--") || !value?.endsWith("px")) continue;
    const px = Number.parseFloat(value);
    if (Number.isFinite(px)) return px;
  }
  return null;
}

function carries(element: Element, style: StyleXStyles): boolean {
  const classes = (stylex.props(style).className ?? "").split(" ").filter(Boolean);
  const present = (element.getAttribute("class") ?? "").split(" ");
  return classes.length > 0 && classes.every((cls) => present.includes(cls));
}

describe("WhiteboardPageRail insert affordance", () => {
  /**
   * The complaint these pin down: approaching a gap used to make the rail move.
   * The caret's row grew from the list's 6px gap to 16px under the pointer, so
   * every page below it slid down and sprang back — the list rippled while you
   * were aiming at it, and the button you were reaching for changed size as it
   * appeared. A caret row is now the list's gap whether or not anything is
   * drawn in it; only the mark inside it fades.
   */
  it("gives every caret row the list's gap, hovered or not", () => {
    const { container } = render(<WhiteboardPageRail {...baseProps} />);
    const carets = [...container.querySelectorAll("button[aria-label^='Insert page']")];
    expect(carets.length).toBeGreaterThan(0);
    for (const caret of carets) expect(carries(caret, marks.caretRow)).toBe(true);
  });

  /**
   * And it appears one gap at a time. The list used to publish a half-opacity
   * caret variable on its own hover, so entering the rail anywhere drew an
   * "insert here" mark in all twenty-two gaps at once to answer a question
   * about one of them. Each caret now publishes its own.
   */
  it("does not reveal every caret when the list is hovered", () => {
    const { container } = render(<WhiteboardPageRail {...baseProps} />);
    for (const element of container.querySelectorAll("*")) {
      expect(carries(element, marks.listWideCaretReveal)).toBe(false);
    }
  });
});

describe("WhiteboardPageRail thumbnails", () => {
  it("shows the page, not just its number", () => {
    const pages = makePages(3);
    const url = "blob:page-2";
    render(
      <WhiteboardPageRail
        {...baseProps}
        pages={pages}
        thumbnails={{
          byPageId: new Map([[String(pages[1].id), { url, width: 176, height: 248, stale: false }]]),
          observe: () => () => {},
        }}
      />,
    );
    const card = screen.getByRole("button", { name: CURRENT_CARD_LABEL });
    expect(card.querySelector("img")?.getAttribute("src")).toBe(url);
    // The number stays, as a corner chip: it is what the pager and the
    // "insert after page 2" labels refer to.
    expect(card.textContent).toContain("2");
  });

  it("gives a card the proportions of the page it stands for", () => {
    // A portrait page must not be drawn as a landscape rectangle, which is what
    // a rail of identical 56x44 cards did to a board of imported A4 pages.
    const pages: WhiteboardPage[] = [
      { id: "shape:portrait" as never, number: 1, y: 0, height: 1600, width: 1200 },
      { id: "shape:landscape" as never, number: 2, y: 1600, height: 900, width: 1200 },
    ];
    render(
      <WhiteboardPageRail {...baseProps} pages={pages} currentPage={1} />,
    );
    // A card's height is a dynamic StyleX style, so it arrives as the inline
    // custom property the generated rule reads — that value is the assertion.
    // 88px wide (the raster's width, so a thumbnail is never upscaled) times
    // each page's own aspect.
    const portrait = screen.getByRole("button", {
      name: "Page 1, current page. Open page actions",
    });
    const landscape = screen.getByRole("button", { name: "Go to page 2" });
    expect(cardHeightPx(portrait)).toBe(117);
    expect(cardHeightPx(landscape)).toBe(66);
  });
});

describe("WhiteboardPageRail page menu", () => {
  /**
   * The reported failure, in one test: on an iPad there was no way to add a
   * page between 4 and 5. The insert caret existed but was gated behind
   * `@media (hover: hover) and (pointer: fine)`, so on a touch device it was
   * rendered at `opacity: 0` and could never be seen; the bottom pager's page
   * picker, which carried the only other "New page" control, is hidden
   * whenever the rail is mounted; and the toolbar's `+` inserts objects, not
   * pages. The menu is the deliberate, discoverable way in.
   */
  it("opens page actions on a second tap of the card you are already on", () => {
    const onInsertPageAfter = vi.fn();
    render(
      <WhiteboardPageRail
        {...baseProps}
        onInsertPageAfter={onInsertPageAfter}
        canDeletePages
        onDeletePage={vi.fn()}
      />,
    );

    // Nothing is open until it is asked for.
    expect(screen.queryByRole("menu")).toBeNull();

    fireEvent.click(screen.getByLabelText(CURRENT_CARD_LABEL));
    expect(screen.getByRole("menu").getAttribute("aria-label")).toBe(
      "Page 2 actions",
    );

    fireEvent.click(screen.getByRole("menuitem", { name: "Insert page above" }));
    // "Above page 2" is "after page 1", which is the number the server takes.
    expect(onInsertPageAfter).toHaveBeenCalledWith(1);
  });

  it("can put a page above page 1, which no control could previously express", () => {
    const onInsertPageAfter = vi.fn();
    render(
      <WhiteboardPageRail
        {...baseProps}
        currentPage={1}
        onInsertPageAfter={onInsertPageAfter}
      />,
    );
    fireEvent.click(
      screen.getByLabelText("Page 1, current page. Open page actions"),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Insert page above" }));
    expect(onInsertPageAfter).toHaveBeenCalledWith(0);
  });

  it("deletes the page the menu is about, not the page you happen to be on", () => {
    const onDeletePage = vi.fn();
    render(
      <WhiteboardPageRail
        {...baseProps}
        currentPage={2}
        canDeletePages
        onDeletePage={onDeletePage}
      />,
    );
    // Reached without navigating there first: a long press on page 3.
    fireEvent.contextMenu(screen.getByLabelText("Go to page 3"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete page" }));
    expect(onDeletePage).toHaveBeenCalledWith(3);
  });

  it("stays with its page when a collaborator deletes an earlier one", () => {
    const onDeletePage = vi.fn();
    const pages = makePages(4);
    const { rerender } = render(
      <WhiteboardPageRail {...baseProps} pages={pages} canDeletePages onDeletePage={onDeletePage} />,
    );
    fireEvent.contextMenu(screen.getByLabelText("Go to page 4"));

    // Page 2 goes away: the page the menu is about is now page 3.
    const renumbered = [pages[0], pages[2], pages[3]].map((page, index) => ({ ...page, number: index + 1 }));
    rerender(
      <WhiteboardPageRail {...baseProps} pages={renumbered} canDeletePages onDeletePage={onDeletePage} />,
    );
    expect(screen.getByRole("menu").getAttribute("aria-label")).toBe("Page 3 actions");
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete page" }));
    expect(onDeletePage).toHaveBeenCalledWith(3);
  });

  it("closes when its page is deleted", () => {
    const pages = makePages(4);
    const { rerender } = render(
      <WhiteboardPageRail {...baseProps} pages={pages} canDeletePages onDeletePage={vi.fn()} />,
    );
    fireEvent.contextMenu(screen.getByLabelText("Go to page 3"));
    const withoutThree = [pages[0], pages[1], pages[3]].map((page, index) => ({ ...page, number: index + 1 }));
    rerender(
      <WhiteboardPageRail {...baseProps} pages={withoutThree} canDeletePages onDeletePage={vi.fn()} />,
    );
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("offers no delete when there is only one page to lose", () => {
    render(
      <WhiteboardPageRail
        {...baseProps}
        pages={makePages(1)}
        currentPage={1}
        canDeletePages
        onDeletePage={vi.fn()}
      />,
    );
    fireEvent.click(
      screen.getByLabelText("Page 1, current page. Open page actions"),
    );
    expect(screen.queryByRole("menuitem", { name: "Delete page" })).toBeNull();
  });

  it("closes on the scrim without acting on the page", () => {
    const onDeletePage = vi.fn();
    const onInsertPageAfter = vi.fn();
    render(
      <WhiteboardPageRail
        {...baseProps}
        canDeletePages
        onDeletePage={onDeletePage}
        onInsertPageAfter={onInsertPageAfter}
      />,
    );
    fireEvent.click(screen.getByLabelText(CURRENT_CARD_LABEL));
    fireEvent.click(screen.getByLabelText("Close page menu"));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(onDeletePage).not.toHaveBeenCalled();
    expect(onInsertPageAfter).not.toHaveBeenCalled();
  });
});
