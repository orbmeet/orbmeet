import {
  Fragment,
  type Mark,
  type Node as ProseMirrorNode,
  type Schema,
} from "@tiptap/pm/model";
import { INLINE_MATH_NODE } from "@orbmeet/whiteboard-core/math/constants";
import { bakeMath } from "./math-input";
import { BOUNDARY, scanMathSpans, type MathSpan } from "./math-spans";

/**
 * Turns delimited source in rich text into equation nodes.
 *
 * Conversion happens where text enters a document, never by re-reading the
 * document afterwards: the closing `$` of a typed equation (the extension's
 * input handler), and content that arrives already written — a paste into the
 * editor, a shape created with rich text. Both read text through
 * `readTextblock`, so they agree on what is prose.
 */

const isCode = (mark: Mark) => !!mark.type.spec.code;

/**
 * A textblock's text as the span scanner reads it, up to `end`: one character
 * per document position, with everything that is not prose — atoms, hard
 * breaks, inline code — replaced by `BOUNDARY` so no equation can reach into
 * or across it.
 */
export function readTextblock(block: ProseMirrorNode, end = block.content.size): string {
  let text = "";
  block.forEach((child, offset) => {
    if (offset >= end) return;
    const size = Math.min(child.nodeSize, end - offset);
    text += child.isText && !child.marks.some(isCode)
      ? child.text!.slice(0, size)
      : BOUNDARY.repeat(size);
  });
  return text;
}

/**
 * The equation node for a span of `block`, or null when its source does not
 * compile. It carries the marks its opening delimiter had, so an equation in
 * a bold or linked run stays bold or linked.
 */
export function createEquation(
  block: ProseMirrorNode,
  span: MathSpan,
): ProseMirrorNode | null {
  const mathType = block.type.schema.nodes[INLINE_MATH_NODE];
  if (!mathType) return null;
  const attrs = bakeMath(span.input, span.displayMode);
  if (!attrs) return null;
  const marks = (block.childAfter(span.from).node?.marks ?? [])
    .filter((mark) => block.type.allowsMarkType(mark.type));
  return mathType.create(attrs, null, marks);
}

/** `block` with its delimited equations converted, or null when it has none. */
function convertTextblock(block: ProseMirrorNode): ProseMirrorNode | null {
  if (block.type.spec.code) return null;
  const text = readTextblock(block);
  if (!text.includes("$")) return null;

  let content = Fragment.empty;
  let cursor = 0;
  for (const span of scanMathSpans(text)) {
    const equation = createEquation(block, span);
    if (!equation) continue;
    content = content.append(block.content.cut(cursor, span.from)).addToEnd(equation);
    cursor = span.to;
  }
  if (cursor === 0) return null;
  return block.copy(content.append(block.content.cut(cursor)));
}

/**
 * `fragment` with every delimited equation that compiles converted, or the
 * same fragment when there is none. A fragment of bare inline content — an
 * open paste slice — is read as one textblock.
 */
export function convertDelimitedMath(fragment: Fragment, schema: Schema): Fragment {
  if (fragment.firstChild?.isInline) {
    const block = schema.topNodeType.contentMatch.defaultType?.create(null, fragment);
    if (!block?.isTextblock) return fragment;
    return convertTextblock(block)?.content ?? fragment;
  }

  let changed = false;
  const children: ProseMirrorNode[] = [];
  fragment.forEach((child) => {
    let next = child;
    if (child.isTextblock) {
      next = convertTextblock(child) ?? child;
    } else if (!child.isLeaf) {
      const content = convertDelimitedMath(child.content, schema);
      if (content !== child.content) next = child.copy(content);
    }
    if (next !== child) changed = true;
    children.push(next);
  });
  return changed ? Fragment.from(children) : fragment;
}

export interface LoneEquation {
  input: string;
  latex: string;
  displayMode: boolean;
}

/**
 * The equation a document consists of, when it holds exactly one and nothing
 * else but whitespace and empty paragraphs. Its attributes are peer-writable,
 * so callers still validate them before trusting the LaTeX.
 */
export function getLoneEquation(doc: ProseMirrorNode): LoneEquation | null {
  let equation: LoneEquation | null = null;
  let other = false;
  doc.descendants((node) => {
    if (other) return false;
    if (node.type.name === INLINE_MATH_NODE) {
      if (equation) other = true;
      else {
        equation = {
          input: typeof node.attrs.input === "string" ? node.attrs.input.trim() : "",
          latex: typeof node.attrs.latex === "string" ? node.attrs.latex : "",
          displayMode: node.attrs.displayMode === true,
        };
      }
      return false;
    }
    if (node.isText) {
      if (node.text?.trim()) other = true;
      return false;
    }
    // A hard break, an image — anything else that is content, not structure.
    if (node.isLeaf) other = true;
    return !other;
  });
  const found = equation as LoneEquation | null;
  return other || !found?.input ? null : found;
}
