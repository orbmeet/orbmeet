// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TLShapeId } from "tldraw";
import type { WhiteboardPage } from "./page-manager";
import { useWhiteboardPageDialogs } from "./use-whiteboard-page-dialogs";

function makePages(count: number): WhiteboardPage[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `shape:page-${index + 1}` as TLShapeId,
    number: index + 1,
    y: index * 900,
    height: 900,
    width: 1200,
  }));
}

function setup(currentPage: number, pageCount: number) {
  const pages = makePages(pageCount);
  const commitDeletePage = vi.fn();

  const result = renderHook(() =>
    useWhiteboardPageDialogs({
      editor: null,
      pages,
      currentPage,
      canEditWhiteboard: true,
      canManagePages: true,
      commitDeletePage,
    }),
  );
  return { ...result, commitDeletePage, pages };
}

describe("useWhiteboardPageDialogs delete targeting", () => {
  it("names the page the rail asked about, not the one you are standing on", () => {
    // The dialog reads its title off this number. It used to read `currentPage`
    // instead, which was only ever right because the sole control that could
    // delete a page meant "this one" — the rail can name any page in the
    // document, and "Delete page 2?" over a request to delete page 7 is worse
    // than no confirmation at all.
    const { result, commitDeletePage, pages } = setup(2, 9);

    act(() => result.current.deletePageByNumber?.(7));
    expect(result.current.showDeletePageDialog).toBe(true);
    expect(result.current.pendingDeletePageNumber).toBe(7);

    act(() => result.current.handleDeletePageConfirmed());
    expect(commitDeletePage).toHaveBeenCalledWith(pages[6].id);
  });

  it("still means the current page when asked the old way", () => {
    const { result, commitDeletePage, pages } = setup(3, 5);

    act(() => result.current.deletePage?.());
    expect(result.current.pendingDeletePageNumber).toBe(3);

    act(() => result.current.handleDeletePageConfirmed());
    expect(commitDeletePage).toHaveBeenCalledWith(pages[2].id);
  });

  it("refuses to delete the only page there is", () => {
    const { result } = setup(1, 1);
    act(() => result.current.deletePageByNumber?.(1));
    expect(result.current.showDeletePageDialog).toBe(false);
    expect(result.current.pendingDeletePageNumber).toBeNull();
  });

  it("ignores a page number that is not in the document", () => {
    const { result } = setup(1, 3);
    act(() => result.current.deletePageByNumber?.(40));
    expect(result.current.showDeletePageDialog).toBe(false);
  });

  it("offers nothing to a viewer who cannot manage pages", () => {
    const pages = makePages(4);
    const { result } = renderHook(() =>
      useWhiteboardPageDialogs({
        editor: null,
        pages,
        currentPage: 1,
        canEditWhiteboard: true,
        canManagePages: false,
        commitDeletePage: vi.fn(),
      }),
    );
    expect(result.current.deletePage).toBeUndefined();
    expect(result.current.deletePageByNumber).toBeUndefined();
  });
});

describe("useWhiteboardPageDialogs clear authority", () => {
  it("cancels a pending clear when edit access is revoked before confirmation", () => {
    const pages = makePages(1);
    const deleteShapes = vi.fn();
    const editor = {
      getSortedChildIdsForParent: () => ["shape:child" as TLShapeId],
      getShape: () => null,
      getCurrentPageShapes: () => [],
      deleteShapes,
    } as never;
    const { result, rerender } = renderHook(
      ({ canEditWhiteboard }: { canEditWhiteboard: boolean }) =>
        useWhiteboardPageDialogs({
          editor,
          pages,
          currentPage: 1,
          canEditWhiteboard,
          canManagePages: false,
          commitDeletePage: vi.fn(),
        }),
      { initialProps: { canEditWhiteboard: true } },
    );

    act(() => result.current.clearPage?.());
    expect(result.current.showClearPageDialog).toBe(true);
    rerender({ canEditWhiteboard: false });
    expect(result.current.showClearPageDialog).toBe(false);

    act(() => result.current.handleClearPageConfirmed());
    expect(deleteShapes).not.toHaveBeenCalled();
  });
});

describe("useWhiteboardPageDialogs clear contents", () => {
  it("clears what is on the page when confirmed, not what was there when asked", () => {
    const pages = makePages(1);
    let children = ["shape:a", "shape:moved-away"] as TLShapeId[];
    const deleteShapes = vi.fn();
    const editor = {
      getSortedChildIdsForParent: () => children,
      getShape: () => null,
      getCurrentPageShapes: () => [],
      deleteShapes,
    } as never;
    const { result } = renderHook(() =>
      useWhiteboardPageDialogs({
        editor,
        pages,
        currentPage: 1,
        canEditWhiteboard: true,
        canManagePages: false,
        commitDeletePage: vi.fn(),
      }),
    );

    act(() => result.current.clearPage?.());
    expect(result.current.showClearPageDialog).toBe(true);
    // While the dialog is open, someone drags a shape to another page and
    // draws a new one here.
    children = ["shape:a", "shape:drawn-meanwhile"] as TLShapeId[];

    act(() => result.current.handleClearPageConfirmed());
    expect(deleteShapes).toHaveBeenCalledExactlyOnceWith(["shape:a", "shape:drawn-meanwhile"]);
  });
});
