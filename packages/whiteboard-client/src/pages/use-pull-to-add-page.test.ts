// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePullToAddPage } from "./use-pull-to-add-page";

describe("usePullToAddPage, by wheel", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setUp() {
    const container = document.createElement("div");
    document.body.append(container);
    const onAddPage = vi.fn();
    const hook = renderHook(() => usePullToAddPage({ enabled: true, ready: true, onAddPage, container }));
    const wheel = (init: WheelEventInit) => {
      container.dispatchEvent(new WheelEvent("wheel", { bubbles: true, ...init }));
      vi.advanceTimersByTime(1_000);
    };
    return { onAddPage, wheel, done: () => { hook.unmount(); container.remove(); } };
  }

  it("adds a page when the board is scrolled past its end", () => {
    const { onAddPage, wheel, done } = setUp();
    wheel({ deltaY: 40 });
    expect(onAddPage).toHaveBeenCalledOnce();
    done();
  });

  it("ignores a zoom: Ctrl with a wheel, or a trackpad pinch", () => {
    const { onAddPage, wheel, done } = setUp();
    wheel({ deltaY: 40, ctrlKey: true });
    expect(onAddPage).not.toHaveBeenCalled();
    done();
  });

  it("ignores a zoom with Cmd held, as tldraw zooms on macOS", () => {
    const { onAddPage, wheel, done } = setUp();
    wheel({ deltaY: 40, metaKey: true });
    expect(onAddPage).not.toHaveBeenCalled();
    done();
  });
});
