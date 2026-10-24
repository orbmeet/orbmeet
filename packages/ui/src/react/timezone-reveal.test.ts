// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import { revealSelectedItem } from "./timezone-select";

/**
 * jsdom performs no layout, so the geometry the helper reads is supplied here.
 * Rows are 20px tall in a 240px window — the real listbox's cap — and the list
 * is scrolled to `scrollTop` when the popup opens.
 */
function buildList({
  selectedIndex,
  scrollTop = 0,
  rowHeight = 20,
  clientHeight = 240,
}: {
  selectedIndex: number | null;
  scrollTop?: number;
  rowHeight?: number;
  clientHeight?: number;
}): HTMLElement {
  const list = document.createElement("div");
  Object.defineProperty(list, "clientHeight", { value: clientHeight });
  list.scrollTop = scrollTop;
  list.getBoundingClientRect = () => ({ top: 100 }) as DOMRect;

  if (selectedIndex !== null) {
    const item = document.createElement("div");
    item.setAttribute("data-selected", "");
    Object.defineProperty(item, "offsetHeight", { value: rowHeight });
    // Where the row sits on screen: its offset within the list, less how far
    // the list is already scrolled, plus the list's own position.
    item.getBoundingClientRect = () =>
      ({ top: 100 + selectedIndex * rowHeight - list.scrollTop }) as DOMRect;
    list.appendChild(item);
  }
  return list;
}

describe("revealing the selected time zone", () => {
  it("centres a selection far below the fold", () => {
    const list = buildList({ selectedIndex: 329 });

    revealSelectedItem(list);

    // Row 329 starts at 6580px; centring it in a 240px window puts the top of
    // the window 110px above that.
    expect(list.scrollTop).toBe(6580 - 110);
  });

  it("is stable once the selection is already centred", () => {
    const list = buildList({ selectedIndex: 329, scrollTop: 6470 });

    revealSelectedItem(list);

    expect(list.scrollTop).toBe(6470);
  });

  it("does not scroll past the top for an early selection", () => {
    const list = buildList({ selectedIndex: 0 });

    revealSelectedItem(list);

    expect(list.scrollTop).toBe(0);
  });

  it("leaves the list alone when nothing is selected or there is no list", () => {
    const list = buildList({ selectedIndex: null, scrollTop: 42 });

    revealSelectedItem(list);
    expect(list.scrollTop).toBe(42);

    expect(() => revealSelectedItem(null)).not.toThrow();
  });
});
