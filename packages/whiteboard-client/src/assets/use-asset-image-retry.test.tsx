// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Editor } from "tldraw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isRetryableAssetUrl, useAssetImageRetry, withAttempt } from "./use-asset-image-retry";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let container: HTMLDivElement;
let root: Root;

function Harness({ editor }: { editor: Editor }) {
  useAssetImageRetry(editor);
  return null;
}

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(document.createElement("div"));
  act(() => root.render(<Harness editor={{ getContainer: () => container } as unknown as Editor} />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

function failingImage(src: string): HTMLImageElement {
  const image = document.createElement("img");
  image.setAttribute("src", src);
  container.append(image);
  image.dispatchEvent(new Event("error"));
  return image;
}

describe("useAssetImageRetry", () => {
  it("asks for a board image that failed again, after a short wait", () => {
    const image = failingImage("/api/wb-assets/whiteboards/wb_1/assets/a.png?whiteboardId=wb_1");
    expect(image.getAttribute("src")).not.toContain("attempt=");
    vi.advanceTimersByTime(500);
    expect(image.getAttribute("src")).toBe("/api/wb-assets/whiteboards/wb_1/assets/a.png?whiteboardId=wb_1&attempt=1");
  });

  it("gives up after a few tries", () => {
    const image = failingImage("/api/wb-assets/whiteboards/wb_1/assets/a.png");
    for (let attempt = 0; attempt < 8; attempt += 1) {
      vi.advanceTimersByTime(10_000);
      image.dispatchEvent(new Event("error"));
    }
    vi.advanceTimersByTime(20_000);
    expect(image.getAttribute("src")).toContain("attempt=5");
  });

  it("leaves images that are not the board's own alone", () => {
    const image = failingImage("https://example.com/cat.png");
    vi.advanceTimersByTime(10_000);
    expect(image.getAttribute("src")).toBe("https://example.com/cat.png");
  });
});

describe("withAttempt", () => {
  it("keeps the rest of the address", () => {
    expect(withAttempt("https://orbmeet.com/api/wb-assets/x.png?whiteboardId=w", 2)).toBe(
      "https://orbmeet.com/api/wb-assets/x.png?whiteboardId=w&attempt=2",
    );
    expect(isRetryableAssetUrl("/api/wb-assets/x.png")).toBe(true);
  });
});
