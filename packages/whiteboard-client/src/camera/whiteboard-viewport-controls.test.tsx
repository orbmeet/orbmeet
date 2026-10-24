import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { WhiteboardViewportControls } from "./whiteboard-viewport-controls";

const pages = [
  {
    id: "shape:page-1" as never,
    number: 1,
    y: 0,
    height: 900,
    width: 1200,
  },
];

const baseProps = {
  canEditWhiteboard: true,
  canAddPages: true,
  pages,
  currentPage: 1,
  zoomPercent: null,
  onPageChange: vi.fn(),
  onAddPage: vi.fn(),
  onZoomIn: vi.fn(),
  onZoomOut: vi.fn(),
  onResetView: vi.fn(),
};

describe("WhiteboardViewportControls", () => {
  it("offers Show sources to readers and editors, on phones and on a regular board", () => {
    for (const [mode, canEditWhiteboard] of [["compact", false], ["regular", false], ["regular", true]] as const) {
      const markup = renderToStaticMarkup(
        <WhiteboardViewportControls
          {...baseProps}
          canEditWhiteboard={canEditWhiteboard}
          chrome={{ mode, toolbarVisible: true, isMeetingPhonePortrait: mode === "compact", pageRailVisible: false, sideways: false }}
          sources={{ showing: true, onToggle: vi.fn() }}
        />,
      );
      expect(markup).toMatch(/aria-label="Show sources" aria-pressed="true"/);
    }
  });

  it("keeps compact screens focused on page navigation", () => {
    const markup = renderToStaticMarkup(
      <WhiteboardViewportControls
        {...baseProps}
        chrome={{
          mode: "compact",
          toolbarVisible: true,
          isMeetingPhonePortrait: true,
          pageRailVisible: false,
          sideways: false,
        }}
      />,
    );

    expect(markup).toContain("Choose page");
    expect(markup).not.toContain("Zoom in");
    expect(markup).not.toContain("Zoom out");
    expect(markup).not.toContain("Fit width");
    expect(markup).toContain('aria-label="New page"');
  });

  it("names the resting view Fit instead of printing a percentage", () => {
    const markup = renderToStaticMarkup(
      <WhiteboardViewportControls
        {...baseProps}
        chrome={{
          mode: "regular",
          toolbarVisible: true,
          isMeetingPhonePortrait: false,
          pageRailVisible: false,
          sideways: false,
        }}
      />,
    );

    expect(markup).toContain("The page fits the board");
    expect(markup).toContain(">Fit<");
    expect(markup).not.toContain("100%");
    expect(markup).toContain("Zoom in");
  });

  it("puts a regular board's controls in the band above the page, never at the bottom", () => {
    const markup = renderToStaticMarkup(
      <WhiteboardViewportControls
        {...baseProps}
        chrome={{
          mode: "regular",
          toolbarVisible: true,
          isMeetingPhonePortrait: false,
          pageRailVisible: false,
          sideways: false,
        }}
      />,
    );

    // A regular board's controls sit in the band under the page, pages at
    // one corner and zoom at the other.
    expect(markup).toContain('data-viewport-placement="band"');
    expect(markup).not.toContain('data-viewport-placement="compact"');
    expect(markup).toContain("Previous page");
    expect(markup).toContain("Page 1 of 1. Show all pages");
    expect(markup).toContain("Zoom in");
    expect(markup).toContain("New page after this one");
  });

  it("opens the page rail from the page control, and leaves adding pages to the rail while it is open", () => {
    const markup = renderToStaticMarkup(
      <WhiteboardViewportControls
        {...baseProps}
        chrome={{
          mode: "regular",
          toolbarVisible: true,
          isMeetingPhonePortrait: false,
          pageRailVisible: true,
          sideways: false,
        }}
        pageRailOpen
      />,
    );

    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain("Page 1 of 1. Hide all pages");
    // The rail ends in its own "+ Page"; a second one a few hundred pixels
    // away is the same control twice.
    expect(markup).not.toContain("New page after this one");
  });

  it("keeps the navigation banner up with the controls", () => {
    const markup = renderToStaticMarkup(
      <WhiteboardViewportControls
        {...baseProps}
        chrome={{
          mode: "regular",
          toolbarVisible: true,
          isMeetingPhonePortrait: false,
          pageRailVisible: true,
          sideways: false,
        }}
        navigationControllerName="Aman"
      />,
    );

    // Between the page and zoom controls, in their band.
    expect(markup).toContain('data-viewport-status-placement="beside"');
    expect(markup).toContain("Aman controls navigation");
  });

  it("sets a reader's request to edit beside the follow pill, never over it", () => {
    const follow = { presenterName: "Maya", following: true, roam: false, follow: vi.fn(), stopFollowing: vi.fn() };
    const chrome = { mode: "compact", toolbarVisible: false, isMeetingPhonePortrait: true, pageRailVisible: false, sideways: false } as const;
    const asking = renderToStaticMarkup(
      <WhiteboardViewportControls {...baseProps} chrome={chrome} follow={follow} editAccess={{ requested: false, onRequest: vi.fn() }} />,
    );
    expect(asking).toContain("Following Maya");
    expect(asking).toContain("Ask to edit");
    expect(asking.indexOf("Following Maya")).toBeLessThan(asking.indexOf("Ask to edit"));
    expect(asking).not.toContain("See whole page");

    const waiting = renderToStaticMarkup(
      <WhiteboardViewportControls {...baseProps} chrome={chrome} follow={follow} editAccess={{ requested: true, onRequest: vi.fn() }} />,
    );
    expect(waiting).toContain("Asked to edit");
    expect(waiting).not.toContain(">Ask to edit<");
  });
});
