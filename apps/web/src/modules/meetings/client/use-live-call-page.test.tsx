// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { LIVE_CALL_PAGE_CLASS, useLiveCallPage } from "./use-live-call-page";

let root: Root | null = null;
let visibility: DocumentVisibilityState = "visible";
beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  visibility = "visible";
  Reflect.deleteProperty(navigator, "wakeLock");
});

function mount(active: boolean) {
  function Probe({ on }: { on: boolean }) {
    useLiveCallPage(on);
    return null;
  }
  root = createRoot(document.createElement("div"));
  act(() => root!.render(<Probe on={active} />));
  return (next: boolean) => act(() => root!.render(<Probe on={next} />));
}

function fakeWakeLock() {
  const sentinels: { released: boolean; release: ReturnType<typeof vi.fn> }[] = [];
  const request = vi.fn(async () => {
    const sentinel = {
      released: false,
      release: vi.fn(async () => {
        sentinel.released = true;
      }),
    };
    sentinels.push(sentinel);
    return sentinel;
  });
  Object.defineProperty(navigator, "wakeLock", { configurable: true, value: { request } });
  return { request, sentinels };
}

function drag(
  type: "dragover" | "drop",
  handledFirst = false,
  { target = window, types = ["text/plain"] }: { target?: EventTarget; types?: string[] } = {},
) {
  const event = new Event(type, { bubbles: true, cancelable: true }) as DragEvent;
  Object.defineProperty(event, "dataTransfer", { value: { dropEffect: "copy", types } });
  if (handledFirst) event.preventDefault();
  target.dispatchEvent(event);
  return event;
}

function field(html: string) {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.appendChild(host);
  return { element: host.firstElementChild!, remove: () => host.remove() };
}

describe("useLiveCallPage", () => {
  it("holds the root still only while the call is live", () => {
    const rerender = mount(true);
    expect(document.documentElement.classList.contains(LIVE_CALL_PAGE_CLASS)).toBe(true);
    expect(document.body.classList.contains(LIVE_CALL_PAGE_CLASS)).toBe(false);
    rerender(false);
    expect(document.documentElement.classList.contains(LIVE_CALL_PAGE_CLASS)).toBe(false);
  });

  it("refuses a drop nothing on the page took, so the tab does not navigate", () => {
    mount(true);
    const over = drag("dragover");
    expect(over.defaultPrevented).toBe(true);
    expect(over.dataTransfer?.dropEffect).toBe("none");
    expect(drag("drop").defaultPrevented).toBe(true);
  });

  it.each(["<input>", '<input type="url">', "<textarea></textarea>", '<div contenteditable="true"><p>x</p></div>'])(
    "lets text or a link dropped into %s be typed into it",
    (html) => {
      mount(true);
      const { element, remove } = field(html);
      const target = element.firstElementChild ?? element;
      const over = drag("dragover", false, { target, types: ["text/uri-list", "text/plain"] });
      expect(over.defaultPrevented).toBe(false);
      expect(over.dataTransfer?.dropEffect).toBe("copy");
      expect(drag("drop", false, { target }).defaultPrevented).toBe(false);
      remove();
    },
  );

  it("still refuses a file dropped on a text field", () => {
    mount(true);
    const input = field("<input>");
    expect(drag("drop", false, { target: input.element, types: ["Files"] }).defaultPrevented).toBe(true);
    input.remove();
  });

  it.each(["<input disabled>", "<textarea readonly></textarea>", '<input type="checkbox">'])(
    "refuses a drop on %s, which cannot take it",
    (html) => {
      mount(true);
      const { element, remove } = field(html);
      expect(drag("drop", false, { target: element }).defaultPrevented).toBe(true);
      remove();
    },
  );

  it("leaves a drop the board handled to the board", () => {
    mount(true);
    const over = drag("dragover", true);
    expect(over.dataTransfer?.dropEffect).toBe("copy");
  });

  it("does not touch drops outside a call", () => {
    mount(false);
    expect(drag("drop").defaultPrevented).toBe(false);
  });

  it("keeps the screen awake, takes the lock again on return, and lets go on leaving", async () => {
    const { request, sentinels } = fakeWakeLock();
    const rerender = mount(true);
    await act(async () => {});
    expect(request).toHaveBeenCalledWith("screen");

    // Hidden: the browser releases the lock. Shown again: take it back.
    sentinels[0].released = true;
    visibility = "hidden";
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(request).toHaveBeenCalledTimes(1);
    visibility = "visible";
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(request).toHaveBeenCalledTimes(2);

    rerender(false);
    expect(sentinels[1].release).toHaveBeenCalled();
  });

  it("goes on without a wake lock the browser refuses", async () => {
    Object.defineProperty(navigator, "wakeLock", {
      configurable: true,
      value: { request: vi.fn(async () => Promise.reject(new DOMException("Low battery", "NotAllowedError"))) },
    });
    mount(true);
    await act(async () => {});
    expect(document.documentElement.classList.contains(LIVE_CALL_PAGE_CLASS)).toBe(true);
  });
});
