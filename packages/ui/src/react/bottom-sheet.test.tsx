// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BottomSheet } from "./bottom-sheet";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"] });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  // Let each sheet's delayed listener cleanup run, so nothing leaks into the
  // next test.
  act(() => {
    vi.runOnlyPendingTimers();
  });
  host.remove();
  vi.useRealTimers();
});

function press(target: Element) {
  const Pointer = window.PointerEvent ?? MouseEvent;
  target.dispatchEvent(new Pointer("pointerdown", { bubbles: true, cancelable: true, button: 0 }));
}

function sheet() {
  return document.querySelector<HTMLElement>('[role="dialog"]');
}

/** A trigger, an unrelated outside button, and the sheet, as a meeting dock has them. */
function Harness({ onOutsideClick = () => {} }: { onOutsideClick?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" data-testid="trigger" onClick={() => setOpen(true)}>
        More options
      </button>
      <button type="button" data-testid="outside" onClick={onOutsideClick}>
        Mute
      </button>
      <BottomSheet open={open} onClose={() => setOpen(false)} title="Meeting options">
        <button type="button" data-testid="row">
          Timeline
        </button>
      </BottomSheet>
    </>
  );
}

function render(ui: React.ReactElement) {
  act(() => root.render(ui));
}

function openFromTrigger() {
  const trigger = document.querySelector<HTMLButtonElement>('[data-testid="trigger"]')!;
  trigger.focus();
  act(() => trigger.click());
  // Two frames to start the entrance.
  act(() => {
    vi.advanceTimersByTime(50);
  });
}

function finishExit() {
  act(() => {
    vi.advanceTimersByTime(300);
  });
}

describe("BottomSheet", () => {
  it("renders nothing while closed", () => {
    render(<Harness />);
    expect(sheet()).toBeNull();
  });

  it("opens as a labelled modal dialog and takes focus", () => {
    render(<Harness />);
    openFromTrigger();
    const dialog = sheet()!;
    expect(dialog).not.toBeNull();
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(document.getElementById(dialog.getAttribute("aria-labelledby")!)?.textContent).toBe("Meeting options");
    expect(document.activeElement).toBe(dialog);
  });

  it("is portalled to <body>, not left inside the caller's (possibly transformed) layout", () => {
    render(<Harness />);
    openFromTrigger();
    expect(sheet()!.parentElement).toBe(document.body);
  });

  it("closes on Escape, unmounts after the exit, and gives focus back to the trigger", () => {
    render(<Harness />);
    openFromTrigger();
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(sheet()?.hasAttribute("data-open")).toBe(false);
    finishExit();
    expect(sheet()).toBeNull();
    expect(document.activeElement).toBe(document.querySelector('[data-testid="trigger"]'));
  });

  it("closes on the Close button", () => {
    render(<Harness />);
    openFromTrigger();
    act(() => document.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click());
    finishExit();
    expect(sheet()).toBeNull();
  });

  it("closes on an outside press and swallows that press's click", () => {
    const onOutsideClick = vi.fn();
    render(<Harness onOutsideClick={onOutsideClick} />);
    openFromTrigger();
    const outside = document.querySelector<HTMLButtonElement>('[data-testid="outside"]')!;
    act(() => {
      press(outside);
      outside.click();
    });
    expect(onOutsideClick).not.toHaveBeenCalled();
    finishExit();
    expect(sheet()).toBeNull();
  });

  it("does not reopen when the outside press lands on its own trigger", () => {
    render(<Harness />);
    openFromTrigger();
    const trigger = document.querySelector<HTMLButtonElement>('[data-testid="trigger"]')!;
    act(() => {
      press(trigger);
      trigger.click();
    });
    finishExit();
    expect(sheet()).toBeNull();
  });

  it("lets later outside clicks through once the dismissing one is past", () => {
    const onOutsideClick = vi.fn();
    render(<Harness onOutsideClick={onOutsideClick} />);
    openFromTrigger();
    const outside = document.querySelector<HTMLButtonElement>('[data-testid="outside"]')!;
    act(() => press(outside));
    finishExit();
    act(() => {
    vi.advanceTimersByTime(1000);
  });
    act(() => outside.click());
    expect(onOutsideClick).toHaveBeenCalledTimes(1);
  });

  it("stays open on a press inside it", () => {
    render(<Harness />);
    openFromTrigger();
    const row = document.querySelector<HTMLButtonElement>('[data-testid="row"]')!;
    act(() => {
      press(row);
      row.click();
    });
    finishExit();
    expect(sheet()).not.toBeNull();
  });

  it("does not pull focus back from a sheet that opened as it closed", () => {
    function Chain() {
      const [first, setFirst] = useState(true);
      const [second, setSecond] = useState(false);
      return (
        <>
          <button type="button" data-testid="trigger">
            More options
          </button>
          <BottomSheet open={first} onClose={() => setFirst(false)} title="Meeting options">
            <button
              type="button"
              data-testid="row"
              onClick={() => {
                setSecond(true);
                setFirst(false);
              }}
            >
              Timeline
            </button>
          </BottomSheet>
          <BottomSheet open={second} onClose={() => setSecond(false)} title="Timeline">
            <input aria-label="Message" />
          </BottomSheet>
        </>
      );
    }
    document.querySelector<HTMLButtonElement>("button")?.focus();
    render(<Chain />);
    act(() => {
    vi.advanceTimersByTime(50);
  });
    act(() => document.querySelector<HTMLButtonElement>('[data-testid="row"]')!.click());
    act(() => {
    vi.advanceTimersByTime(50);
  });
    const timeline = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find(
      (d) => d.querySelector("h2")?.textContent === "Timeline",
    )!;
    expect(document.activeElement).toBe(timeline);
    finishExit();
    expect(document.activeElement).toBe(timeline);
  });
});
