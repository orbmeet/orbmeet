// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WhiteboardToolbarPopover } from "./whiteboard-toolbar-popover";

afterEach(cleanup);

/** Base UI opens on a real pointer sequence, not a bare click. */
function press(element: Element) {
  fireEvent.pointerDown(element, { pointerType: "mouse", button: 0 });
  fireEvent.pointerUp(element, { pointerType: "mouse", button: 0 });
  fireEvent.click(element, { detail: 1 });
}

function Harness({
  isOpen,
  onToggle = () => {},
  onClose = () => {},
  label = "Page background",
}: {
  isOpen: boolean;
  onToggle?: () => void;
  onClose?: () => void;
  label?: string;
}) {
  return (
    <WhiteboardToolbarPopover
      label={label}
      isOpen={isOpen}
      onToggle={onToggle}
      onClose={onClose}
      width={220}
      trigger={<button type="button">Background</button>}
    >
      <button type="button">Grid</button>
      <button type="button">Dots</button>
    </WhiteboardToolbarPopover>
  );
}

describe("WhiteboardToolbarPopover", () => {
  it("names each panel for itself rather than sharing one generic label", async () => {
    render(<Harness isOpen label="Shape properties" />);
    await waitFor(() =>
      expect(screen.getByRole("dialog", { name: "Shape properties" })).toBeTruthy(),
    );
  });

  it("links the trigger to the panel it opens", async () => {
    const { rerender } = render(<Harness isOpen={false} />);
    const trigger = screen.getByRole("button", { name: "Background" });
    // Announced as a collapsed control that opens a dialog — wiring the
    // hand-rolled portal never had, on any of its four call sites.
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");

    rerender(<Harness isOpen />);
    const panel = await screen.findByRole("dialog", { name: "Page background" });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(trigger.getAttribute("aria-controls")).toBe(panel.id);
  });

  it("routes opening through onToggle so the toolbar can close its other panels", () => {
    const onToggle = vi.fn();
    const onClose = vi.fn();
    render(<Harness isOpen={false} onToggle={onToggle} onClose={onClose} />);

    press(screen.getByRole("button", { name: "Background" }));

    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("asks to close on Escape", async () => {
    const onClose = vi.fn();
    render(<Harness isOpen onClose={onClose} />);
    const panel = await screen.findByRole("dialog");

    fireEvent.keyDown(panel, { key: "Escape" });

    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("asks to close on an outside press", async () => {
    const onClose = vi.fn();
    render(
      <>
        <Harness isOpen onClose={onClose} />
        <button type="button">Elsewhere</button>
      </>,
    );
    await screen.findByRole("dialog");

    press(screen.getByRole("button", { name: "Elsewhere" }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("moves focus into the panel on open", async () => {
    render(<Harness isOpen />);
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Grid" })),
    );
  });
});
