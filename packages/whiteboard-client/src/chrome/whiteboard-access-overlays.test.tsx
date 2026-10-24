import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { WhiteboardAccessOverlays } from "./whiteboard-access-overlays";

const baseProps = {
  isDraggingOver: false,
  canDropContent: false,
  showClearPageDialog: false,
  showDeletePageDialog: false,
  currentPage: 1,
  onCancelClearPage: vi.fn(),
  onConfirmClearPage: vi.fn(),
  onCancelDeletePage: vi.fn(),
  onConfirmDeletePage: vi.fn(),
};

describe("WhiteboardAccessOverlays", () => {
  it("renders destructive confirmations as labelled modal alert dialogs", () => {
    const markup = renderToStaticMarkup(
      <WhiteboardAccessOverlays {...baseProps} showDeletePageDialog />,
    );

    expect(markup).toContain('role="alertdialog"');
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain("Delete page 1?");
    expect(markup).toContain("aria-labelledby=");
    expect(markup).toContain("aria-describedby=");
  });
});
