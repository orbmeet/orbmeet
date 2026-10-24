import { richTextValidator } from "@tldraw/tlschema";
import {
  INLINE_MATH_NODE,
  MAX_MATH_INPUT_LENGTH,
  MAX_MATH_LATEX_LENGTH,
  MAX_RICH_TEXT_DEPTH,
  MAX_RICH_TEXT_LENGTH,
  MAX_RICH_TEXT_NODES,
} from "./constants.ts";

interface RichTextNode {
  type?: unknown;
  attrs?: unknown;
  content?: unknown;
  text?: unknown;
}

/**
 * Walk the whole document once, bounding both what this schema adds (inline
 * math) and the shape of the document itself.
 *
 * The traversal is iterative so that validating a hostile document cannot
 * itself overflow the stack. That is also why the depth bound has to be
 * explicit: an iterative acceptor happily admits nesting that every recursive
 * consumer downstream — tldraw's font collection among them — cannot walk.
 */
function assertBoundedRichText(value: unknown): void {
  const pending: Array<{ node: unknown; depth: number }> = [{ node: value, depth: 0 }];
  let nodes = 0;
  let textLength = 0;

  while (pending.length > 0) {
    const { node: current, depth } = pending.pop()!;
    if (!current || typeof current !== "object") continue;
    const node = current as RichTextNode;

    nodes += 1;
    if (nodes > MAX_RICH_TEXT_NODES) {
      throw new Error(`Expected rich text to hold at most ${MAX_RICH_TEXT_NODES} nodes`);
    }
    if (depth > MAX_RICH_TEXT_DEPTH) {
      throw new Error(`Expected rich text to nest at most ${MAX_RICH_TEXT_DEPTH} levels deep`);
    }
    if (typeof node.text === "string") {
      textLength += node.text.length;
      if (textLength > MAX_RICH_TEXT_LENGTH) {
        throw new Error(
          `Expected rich text to hold at most ${MAX_RICH_TEXT_LENGTH} characters`,
        );
      }
    }

    if (node.type === INLINE_MATH_NODE) {
      if (!node.attrs || typeof node.attrs !== "object") {
        throw new Error("Expected inline math attributes");
      }
      const attrs = node.attrs as Record<string, unknown>;
      if (typeof attrs.input !== "string") {
        throw new Error("Expected inline math input to be a string");
      }
      if (attrs.input.length > MAX_MATH_INPUT_LENGTH) {
        throw new Error(`Expected inline math input to be at most ${MAX_MATH_INPUT_LENGTH} characters`);
      }
      if (typeof attrs.latex !== "string") {
        throw new Error("Expected inline math LaTeX to be a string");
      }
      if (attrs.latex.length > MAX_MATH_LATEX_LENGTH) {
        throw new Error(`Expected inline math LaTeX to be at most ${MAX_MATH_LATEX_LENGTH} characters`);
      }
      if (typeof attrs.displayMode !== "boolean") {
        throw new Error("Expected inline math display mode to be a boolean");
      }
    }

    if (Array.isArray(node.content)) {
      for (let index = node.content.length - 1; index >= 0; index -= 1) {
        pending.push({ node: node.content[index], depth: depth + 1 });
      }
    }
  }
}

/** Default tldraw rich text deliberately treats descendants as opaque JSON. */
export const boundedRichTextValidator = richTextValidator.check(
  "bounded rich text",
  assertBoundedRichText,
);
