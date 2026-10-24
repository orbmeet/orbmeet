// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WhiteboardChromeConfig } from "../chrome/whiteboard-chrome";
import { WhiteboardViewportControls } from "./whiteboard-viewport-controls";

afterEach(cleanup);

const props = {
  canEditWhiteboard: true,
  canAddPages: true,
  pages: [{ id: "shape:page-1" as never, number: 1, y: 0, height: 900, width: 1200 }],
  currentPage: 1,
  zoomPercent: null,
  onPageChange: vi.fn(),
  onAddPage: vi.fn(),
  onZoomIn: vi.fn(),
  onZoomOut: vi.fn(),
  onResetView: vi.fn(),
};

const docked: WhiteboardChromeConfig = {
  mode: "compact",
  toolbarVisible: true,
  isMeetingPhonePortrait: true,
  pageRailVisible: false,
  sideways: false,
};

describe("WhiteboardViewportControls height", () => {
  it("reports a height docked and in the corner band, and null once they stand sideways", () => {
    const onControlsHeightChange = vi.fn();
    const { rerender } = render(
      <WhiteboardViewportControls {...props} chrome={docked} onControlsHeightChange={onControlsHeightChange} />,
    );
    // jsdom lays nothing out, so the measured height is 0 — but it is a number.
    expect(onControlsHeightChange).toHaveBeenLastCalledWith(expect.any(Number));

    rerender(
      <WhiteboardViewportControls
        {...props}
        chrome={{ ...docked, mode: "regular", isMeetingPhonePortrait: false }}
        onControlsHeightChange={onControlsHeightChange}
      />,
    );
    // The band wraps to a second row on a narrow board; the camera clears it.
    expect(onControlsHeightChange).toHaveBeenLastCalledWith(expect.any(Number));

    rerender(
      <WhiteboardViewportControls
        {...props}
        chrome={{ ...docked, sideways: true }}
        onControlsHeightChange={onControlsHeightChange}
      />,
    );
    expect(onControlsHeightChange).toHaveBeenLastCalledWith(null);
  });

  it("reports null when it was only ever sideways", () => {
    const onControlsHeightChange = vi.fn();
    render(
      <WhiteboardViewportControls
        {...props}
        chrome={{ ...docked, sideways: true }}
        onControlsHeightChange={onControlsHeightChange}
      />,
    );
    expect(onControlsHeightChange).toHaveBeenCalledWith(null);
    expect(onControlsHeightChange).not.toHaveBeenCalledWith(expect.any(Number));
  });
});

describe("WhiteboardViewportControls handoff menu", () => {
  const regular: WhiteboardChromeConfig = { ...docked, mode: "regular", isMeetingPhonePortrait: false };
  const handoffProps = (controller: string | null) => ({
    ...props,
    chrome: regular,
    canManageNavigation: true,
    myUserId: "me",
    navigationControllerName: controller,
    connectedUsers: [{ userId: "me", userName: "Me" }, { userId: "maya", userName: "Maya" }],
    onSetNavigationController: vi.fn(),
  });

  it("stays closed when its trigger comes back after someone else took control", () => {
    const { rerender } = render(<WhiteboardViewportControls {...handoffProps(null)} />);
    fireEvent.click(screen.getByRole("button", { name: "Hand off navigation control" }));
    expect(screen.getByRole("button", { name: "Close handoff menu" })).toBeTruthy();

    rerender(<WhiteboardViewportControls {...handoffProps("Maya")} />);
    rerender(<WhiteboardViewportControls {...handoffProps(null)} />);

    expect(screen.getByRole("button", { name: "Hand off navigation control" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Close handoff menu" })).toBeNull();
  });
});
