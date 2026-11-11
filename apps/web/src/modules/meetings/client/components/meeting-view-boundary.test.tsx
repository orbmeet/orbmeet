// @vitest-environment jsdom
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { MeetingViewBoundary } from "./meeting-view-boundary";

let root: Root | null = null;
beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  vi.restoreAllMocks();
});

it("keeps the connection mounted when the view crashes, and rebuilds the view on request", () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  let crash = true;
  const connectionUnmounted = vi.fn();
  function Connection({ children }: { children: React.ReactNode }) {
    React.useEffect(() => connectionUnmounted, []);
    return <>{children}</>;
  }
  function View() {
    if (crash) throw new Error("A panel broke");
    return <p>meeting view</p>;
  }

  const container = document.createElement("div");
  root = createRoot(container);
  act(() => root!.render(
    <Connection>
      <MeetingViewBoundary>
        <View />
      </MeetingViewBoundary>
    </Connection>,
  ));

  expect(container.textContent).toContain("You are still in the call");
  expect(connectionUnmounted).not.toHaveBeenCalled();

  crash = false;
  act(() => container.querySelector("button")!.click());
  expect(container.textContent).toContain("meeting view");
  expect(connectionUnmounted).not.toHaveBeenCalled();
});
