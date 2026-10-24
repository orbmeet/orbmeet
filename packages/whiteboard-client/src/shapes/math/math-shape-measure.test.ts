// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMathShapeSize, MATH_BASE_FONT_SIZE } from "@orbmeet/whiteboard-core/math-shape-schema";
import { measureMathShape } from "./math-shape-util";

afterEach(() => {
  vi.restoreAllMocks();
});

/** jsdom has no layout; report a size proportional to the host's font size. */
function stubLayout() {
  const hosts: HTMLElement[] = [];
  const sizeOf = (element: HTMLElement) => parseFloat(element.parentElement!.style.fontSize);
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
    if (this.parentElement?.isConnected) hosts.push(this.parentElement);
    return this.parentElement ? sizeOf(this) * 2 : 0;
  });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.parentElement ? sizeOf(this) : 0;
  });
  return hosts;
}

describe("measureMathShape", () => {
  it("measures the rendered equation at the shape's font size", () => {
    stubLayout();
    const fontSize = MATH_BASE_FONT_SIZE * 2;
    expect(measureMathShape("x^{2}", false, 2)).toEqual(getMathShapeSize(fontSize * 2, fontSize));
  });

  it("measures off-screen and cleans up after itself", () => {
    const hosts = stubLayout();
    measureMathShape("x^{2}", false, 1);
    expect(hosts).toHaveLength(1);
    expect(hosts[0].style.visibility).toBe("hidden");
    expect(hosts[0].isConnected).toBe(false);
  });

  it("gives up without layout or a renderable equation", () => {
    expect(measureMathShape("x^{2}", false, 1)).toBeNull();
    stubLayout();
    expect(measureMathShape("\\frac", false, 1)).toBeNull();
  });
});
