// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { onNextUserGesture } from "./user-gesture";

function pointer(type: string, pointerType: string): Event {
  return Object.assign(new Event(type), { pointerType });
}

describe("onNextUserGesture", () => {
  let dispose: () => void = () => {};
  afterEach(() => dispose());

  it("waits for the end of a tap, where touch carries activation", () => {
    const handler = vi.fn();
    dispose = onNextUserGesture(handler);

    window.dispatchEvent(pointer("pointerdown", "touch"));
    expect(handler).not.toHaveBeenCalled();

    window.dispatchEvent(pointer("pointerup", "touch"));
    expect(handler).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new Event("touchend"));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("takes a mouse press at once", () => {
    const handler = vi.fn();
    dispose = onNextUserGesture(handler);

    window.dispatchEvent(pointer("pointerdown", "mouse"));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("passes over Escape, which carries no activation", () => {
    const handler = vi.fn();
    dispose = onNextUserGesture(handler);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(handler).not.toHaveBeenCalled();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
