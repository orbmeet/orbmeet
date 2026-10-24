import { describe, expect, it } from "vitest";
import { getSchema } from "@tiptap/core";
import { INLINE_MATH_NODE } from "../shapes/math/inline-math-extension";
import { WHITEBOARD_TLDRAW_OPTIONS } from "./tldraw-options";
import { addWhiteboardFontsFromNode } from "../shapes/math/katex-fonts";

describe("WHITEBOARD_TLDRAW_OPTIONS", () => {
  it("keeps native tldraw pages disabled", () => {
    expect(WHITEBOARD_TLDRAW_OPTIONS.maxPages).toBe(1);
  });

  it("allows locked shapes to be selected for inspection", () => {
    expect(WHITEBOARD_TLDRAW_OPTIONS.selectLockedShapes).toBe(true);
  });

  it("can deserialize inline math on every whiteboard mount", () => {
    const extensions = WHITEBOARD_TLDRAW_OPTIONS.text.tipTapConfig.extensions;
    const extensionNames = extensions.map((extension) => extension.name);

    expect(extensionNames).toContain(INLINE_MATH_NODE);
    expect(() => getSchema(extensions).nodeFromJSON({
      type: "doc",
      content: [{
        type: "paragraph",
        content: [{
          type: INLINE_MATH_NODE,
          attrs: { input: "x^2", latex: "x^{2}", displayMode: false },
        }],
      }],
    })).not.toThrow();
  });

  it("declares the fonts equations are set in, so tldraw measures them loaded", () => {
    expect(WHITEBOARD_TLDRAW_OPTIONS.text.addFontsFromNode).toBe(addWhiteboardFontsFromNode);
  });
});
