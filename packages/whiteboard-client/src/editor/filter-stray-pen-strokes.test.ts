import { afterEach, describe, expect, it, vi } from "vitest";
import { b64Vecs, type Editor } from "tldraw";
import { registerStrayPenStrokeFilter } from "./filter-stray-pen-strokes";

describe("registerStrayPenStrokeFilter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("cancels scheduled frame work during cleanup", () => {
    const captured: {
      afterChange?: (
        previous: unknown,
        next: unknown,
        source: "user",
      ) => void;
    } = {};
    const unregister = vi.fn();
    const cancelAnimationFrame = vi.fn();
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 42));
    vi.stubGlobal("cancelAnimationFrame", cancelAnimationFrame);

    const editor = {
      sideEffects: {
        registerAfterChangeHandler: (
          _type: string,
          handler: NonNullable<typeof captured.afterChange>,
        ) => {
          captured.afterChange = handler;
          return unregister;
        },
      },
    } as unknown as Editor;

    const cleanup = registerStrayPenStrokeFilter(editor);
    captured.afterChange?.(
      null,
      {
        id: "shape:stroke",
        type: "draw",
        props: {
          isPen: true,
          isComplete: true,
          segments: [{
            type: "free",
            path: b64Vecs.encodePoints([
              { x: 0, y: 0, z: 0.5 },
              { x: 1_000, y: 0, z: 0.5 },
            ]),
          }],
        },
      },
      "user",
    );
    cleanup();

    expect(unregister).toHaveBeenCalledOnce();
    expect(cancelAnimationFrame).toHaveBeenCalledWith(42);
  });
});
