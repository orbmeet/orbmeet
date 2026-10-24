// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useDelayedFlag } from "./use-delayed-flag";

let root: Root | null = null;
let shown = false;

function Probe({ active }: { active: boolean }) {
  shown = useDelayedFlag(active, 1500);
  return null;
}

function render(active: boolean) {
  root ??= createRoot(document.createElement("div"));
  act(() => root!.render(<Probe active={active} />));
}

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  vi.useRealTimers();
});

describe("useDelayedFlag", () => {
  it("turns on only after the state has held for the delay, and off at once", () => {
    render(true);
    expect(shown).toBe(false);
    act(() => {
      vi.advanceTimersByTime(1499);
    });
    expect(shown).toBe(false);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(shown).toBe(true);

    render(false);
    expect(shown).toBe(false);
  });

  it("starts the delay over after a blip", () => {
    render(true);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    render(false);
    render(true);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(shown).toBe(false);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(shown).toBe(true);
  });
});
