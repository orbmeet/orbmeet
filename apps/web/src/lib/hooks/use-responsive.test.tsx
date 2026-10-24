// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { useResponsive } from "./use-responsive";

let root: Root | null = null;
beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
});

function resizeTo(width: number, height: number) {
  Object.assign(window, { innerWidth: width, innerHeight: height });
  window.dispatchEvent(new Event("resize"));
}

describe("useResponsive", () => {
  it("re-renders only when the viewport crosses a breakpoint", () => {
    resizeTo(1400, 900);
    let renders = 0;
    let latest = "";
    function Probe() {
      renders++;
      latest = useResponsive().mode;
      return null;
    }
    root = createRoot(document.createElement("div"));
    act(() => root!.render(<Probe />));
    const initialRenders = renders;

    act(() => {
      resizeTo(1380, 900);
      resizeTo(1300, 880);
    });
    expect(renders).toBe(initialRenders);

    act(() => resizeTo(500, 900));
    expect(latest).toBe("phone");
    expect(renders).toBe(initialRenders + 1);
  });
});
