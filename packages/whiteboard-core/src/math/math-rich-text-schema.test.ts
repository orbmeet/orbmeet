import { describe, expect, it } from "vitest";
import {
  INLINE_MATH_NODE,
  MAX_MATH_INPUT_LENGTH,
  MAX_MATH_LATEX_LENGTH,
  MAX_RICH_TEXT_DEPTH,
  MAX_RICH_TEXT_LENGTH,
} from "./constants.ts";
import { boundedRichTextValidator } from "./math-rich-text-schema.ts";

const richTextWithMath = (attrs: Record<string, unknown>) => ({
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [{ type: INLINE_MATH_NODE, attrs }],
    },
  ],
});

describe("boundedRichTextValidator", () => {
  it("accepts a bounded inline equation", () => {
    expect(
      boundedRichTextValidator.isValid(
        richTextWithMath({ input: "x^2", latex: "x^{2}", displayMode: false }),
      ),
    ).toBe(true);
  });

  it("rejects peer-written source or LaTeX above the renderer bounds", () => {
    expect(
      boundedRichTextValidator.isValid(
        richTextWithMath({
          input: "x".repeat(MAX_MATH_INPUT_LENGTH + 1),
          latex: "x",
          displayMode: false,
        }),
      ),
    ).toBe(false);
    expect(
      boundedRichTextValidator.isValid(
        richTextWithMath({
          input: "x",
          latex: "x".repeat(MAX_MATH_LATEX_LENGTH + 1),
          displayMode: false,
        }),
      ),
    ).toBe(false);
  });

  it("rejects malformed math attributes hidden inside otherwise opaque rich text", () => {
    expect(
      boundedRichTextValidator.isValid(
        richTextWithMath({ input: {}, latex: "x", displayMode: false }),
      ),
    ).toBe(false);
  });

  it("bounds nesting depth, which the byte caps cannot", () => {
    // Rich text is walked recursively by its consumers — tldraw's font
    // collection among them — while this validator walks it iteratively. Deep
    // nesting therefore costs almost nothing to accept and overflows the stack
    // on the reading side, and 10,000 levels fit easily inside one frame.
    expect(boundedRichTextValidator.isValid(nested(MAX_RICH_TEXT_DEPTH - 1))).toBe(true);
    expect(boundedRichTextValidator.isValid(nested(10_000))).toBe(false);
  });

  it("rejects nesting that a recursive consumer cannot walk", () => {
    const value = nested(50_000);
    // The shape of every downstream rich-text walker: recursion over content.
    const walk = (node: unknown): number => {
      if (!node || typeof node !== "object") return 0;
      const content = (node as { content?: unknown }).content;
      if (!Array.isArray(content)) return 1;
      return 1 + content.reduce((total, child) => total + walk(child), 0);
    };
    expect(() => walk(value)).toThrow(RangeError);
    expect(boundedRichTextValidator.isValid(value)).toBe(false);
  });

  it("bounds total text length across the whole document", () => {
    const chunk = "x".repeat(10_000);
    const overLimit = {
      type: "doc",
      content: Array.from(
        { length: Math.ceil(MAX_RICH_TEXT_LENGTH / chunk.length) + 1 },
        () => ({ type: "text", text: chunk }),
      ),
    };
    expect(boundedRichTextValidator.isValid(overLimit)).toBe(false);
  });

  it("iterates rich-text arrays larger than the JavaScript argument limit", () => {
    const value = {
      type: "doc",
      content: [{
        type: "paragraph",
        content: Array.from({ length: 150_000 }, () => ({ type: "text", text: "x" })),
      }],
    };
    expect(boundedRichTextValidator.isValid(value)).toBe(true);
  });
});

/** `depth` levels of single-child nesting, the cheapest hostile shape. */
function nested(depth: number) {
  let node: Record<string, unknown> = { type: "text", text: "x" };
  for (let level = 0; level < depth; level += 1) {
    node = { type: "bulletList", content: [node] };
  }
  return { type: "doc", content: [node] };
}
