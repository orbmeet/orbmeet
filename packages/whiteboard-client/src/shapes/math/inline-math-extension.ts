import { Node, mergeAttributes } from "@tiptap/core";
import { Slice, type Mark, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import {
  NodeSelection,
  Plugin,
  PluginKey,
  TextSelection,
  type EditorState,
  type Transaction,
} from "@tiptap/pm/state";
import type { EditorView, NodeView } from "@tiptap/pm/view";
import { danger, neutral, violet } from "@orbmeet/ui/tokens/colors.stylex";
import { fonts } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";
import { INLINE_MATH_NODE } from "@orbmeet/whiteboard-core/math/constants";
import { mathColors } from "./math-shape-tokens.stylex";
import { MAX_MATH_INPUT_LENGTH, compileMathInput, resolveMathLatex } from "./math-input";
import { renderKatex } from "./katex-renderer";
import { convertDelimitedMath, createEquation, readTextblock } from "./math-conversion";
import { scanMathSpans } from "./math-spans";

export { INLINE_MATH_NODE } from "@orbmeet/whiteboard-core/math/constants";

const styles = stylex.create({
  inline: {
    display: "inline-block",
    verticalAlign: "baseline",
    color: "inherit",
  },
  pending: {
    opacity: 0.65,
    fontFamily: fonts.mono,
    fontSize: "0.9em",
  },
  view: {
    position: "relative",
    display: "inline-block",
    borderRadius: "3px",
    cursor: "pointer",
  },
  selected: {
    outlineWidth: 2,
    outlineStyle: "solid",
    outlineColor: violet.v300,
    outlineOffset: 1,
  },
  editor: {
    position: "absolute",
    top: "calc(100% + 4px)",
    left: 0,
    zIndex: 1,
    display: "flex",
    flexDirection: "column",
    gap: 3,
    width: "max-content",
    minWidth: 220,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: mathColors.editorBorder,
    borderRadius: "8px",
    backgroundColor: mathColors.surface,
    padding: 6,
    boxShadow: `0 8px 24px color-mix(in oklab, ${violet.v900} 14%, transparent)`,
    cursor: "auto",
  },
  input: {
    width: "100%",
    borderWidth: 0,
    outlineWidth: 0,
    backgroundColor: "transparent",
    color: mathColors.text,
    fontFamily: fonts.mono,
    fontSize: "13px",
    lineHeight: 1.4,
  },
  feedback: {
    fontFamily: "Figtree, system-ui, sans-serif",
    fontSize: "9px",
    fontStyle: "normal",
    fontWeight: 400,
    whiteSpace: "nowrap",
  },
  hint: { color: neutral.n500 },
  error: { color: danger.d700 },
});

const className = (...style: Array<stylex.StyleXStyles | false>) =>
  stylex.props(...style).className ?? "";

interface MathAttrs {
  input: string;
  latex: string;
  displayMode: boolean;
}

/**
 * Rich-text descendants are peer-writable JSON and old snapshots predate the
 * server-side bounds. Treat the baked LaTeX as canonical when it is valid;
 * otherwise derive a bounded local fallback from the source without syncing it.
 */
function normalizeMathAttrs(attrs: {
  input?: unknown;
  latex?: unknown;
  displayMode?: unknown;
}): MathAttrs {
  const rawInput = typeof attrs.input === "string" ? attrs.input : "";
  const input = rawInput.slice(0, MAX_MATH_INPUT_LENGTH);
  const rawLatex = typeof attrs.latex === "string" ? attrs.latex : "";
  const latex = resolveMathLatex(rawInput, rawLatex, attrs.displayMode === true) ?? "";

  return { input, latex, displayMode: attrs.displayMode === true };
}

/**
 * Renders one equation through the same bounded, validated KaTeX path used by
 * standalone shapes and exports.
 */
function renderMathElement(attrs: {
  input?: unknown;
  latex?: unknown;
  displayMode?: unknown;
}): HTMLElement {
  const normalized = normalizeMathAttrs(attrs);
  const span = document.createElement("span");
  const html = normalized.latex ? renderKatex(normalized.latex, normalized.displayMode) : null;
  span.className = ["orbmeet-inline-math", className(styles.inline, !html && styles.pending)]
    .filter(Boolean)
    .join(" ");
  span.setAttribute("data-math-input", normalized.input);
  span.setAttribute("data-math-latex", normalized.latex);
  if (normalized.displayMode) span.setAttribute("data-math-display", "true");

  if (html) {
    span.innerHTML = html;
  } else {
    const delimiter = normalized.displayMode ? "$$" : "$";
    span.textContent = `${delimiter}${normalized.input}${delimiter}`;
    span.setAttribute("data-math-pending", "true");
  }
  return span;
}

/**
 * Math inside ordinary text. The delimiters are the whole interface: type
 * `$x^2$` mid-sentence and the closing `$` turns the source into the equation,
 * with the rest of the line untouched. Backspace straight after takes it back
 * to the text that was typed, for the times a `$` was money after all.
 *
 * It is an atom because an equation is one thing to the sentence around it —
 * the caret steps over it, Backspace selects it before deleting it, and its
 * source is edited in place: click it, or select it and press Enter.
 */
export const InlineMathExtension = Node.create({
  name: INLINE_MATH_NODE,
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      // The source stays on the node so the expression survives a round trip
      // through plain text, and so a failed render still shows what was meant.
      input: { default: "" },
      latex: { default: "" },
      displayMode: { default: false },
    };
  },

  parseHTML() {
    return [
      {
        tag: "span[data-math-input]",
        getAttrs: (element) => {
          if (typeof element === "string") return false;
          // Pasted HTML can carry anything in these attributes, so clamp them to
          // the same bounds the typed and stored paths enforce.
          return normalizeMathAttrs({
            input: element.getAttribute("data-math-input") ?? "",
            latex: element.getAttribute("data-math-latex") ?? "",
            displayMode: element.hasAttribute("data-math-display"),
          });
        },
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    const element = renderMathElement(node.attrs);
    for (const [key, value] of Object.entries(mergeAttributes(HTMLAttributes))) {
      if (
        key.startsWith("data-math") ||
        key === "input" ||
        key === "latex" ||
        key === "displayMode" ||
        value == null
      ) {
        continue;
      }
      element.setAttribute(key, String(value));
    }
    return element;
  },

  /**
   * What the node contributes to plain text. Keeping the delimiters means
   * copying a sentence out and pasting it back rebuilds the same equation.
   */
  renderText({ node }) {
    const attrs = normalizeMathAttrs(node.attrs);
    const delimiter = attrs.displayMode ? "$$" : "$";
    return `${delimiter}${attrs.input}${delimiter}`;
  },

  addNodeView() {
    return ({ node, view, getPos }) => new InlineMathView(node, view, getPos);
  },

  addKeyboardShortcuts() {
    const isEquation = (node: ProseMirrorNode | null | undefined) => node?.type === this.type;
    return {
      Backspace: ({ editor }) => {
        const { state, view } = editor;
        const { selection } = state;
        if (!selection.empty) return false;
        const typed = typingKey.getState(state);
        if (typed && selection.from === typed.to) {
          view.dispatch(state.tr.replaceWith(
            typed.from,
            typed.to,
            state.schema.text(typed.source, typed.marks),
          ));
          return true;
        }
        const before = selection.$from.nodeBefore;
        if (!isEquation(before)) return false;
        view.dispatch(state.tr.setSelection(
          NodeSelection.create(state.doc, selection.from - before!.nodeSize),
        ));
        return true;
      },
      Delete: ({ editor }) => {
        const { state, view } = editor;
        const { selection } = state;
        if (!selection.empty || !isEquation(selection.$from.nodeAfter)) return false;
        view.dispatch(state.tr.setSelection(NodeSelection.create(state.doc, selection.from)));
        return true;
      },
      Enter: ({ editor }) => {
        const { selection } = editor.state;
        if (!(selection instanceof NodeSelection) || !isEquation(selection.node)) return false;
        const dom = editor.view.nodeDOM(selection.from);
        return !!(dom && openViews.get(dom)?.open());
      },
    };
  },

  addProseMirrorPlugins() {
    return [createConversionPlugin()];
  },
});

/** The conversion the last keystroke made, which Backspace can take back. */
interface TypedEquation {
  from: number;
  to: number;
  /** The text as typed, closing delimiter included. */
  source: string;
  marks: readonly Mark[];
}

const typingKey = new PluginKey<TypedEquation | null>("inlineMathConversion");

const isCodeMark = (mark: Mark) => !!mark.type.spec.code;

/**
 * Whether `offset` sits after an unmatched backtick, in text the closing
 * backtick is about to turn into inline code — where a `$` is part of a code
 * listing, not a delimiter.
 */
function isInOpenCodeSpan(block: ProseMirrorNode, offset: number): boolean {
  let backticks = 0;
  block.forEach((child, start) => {
    if (start >= offset || !child.isText || child.marks.some(isCodeMark)) return;
    for (const char of child.text!.slice(0, offset - start)) if (char === "`") backticks++;
  });
  return backticks % 2 === 1;
}

/**
 * The transaction that types a `$` at `pos` and turns the equation it closes
 * into a node, or null when this `$` closes nothing — it opens an equation, is
 * escaped, is money, or the source does not compile.
 */
function typeClosingDelimiter(state: EditorState, pos: number): Transaction | null {
  const $pos = state.doc.resolve(pos);
  const block = $pos.parent;
  if (!block.isTextblock || block.type.spec.code) return null;
  if ((state.storedMarks ?? $pos.marks()).some(isCodeMark)) return null;
  if (isInOpenCodeSpan(block, $pos.parentOffset)) return null;

  const text = `${readTextblock(block, $pos.parentOffset)}$`;
  const span = scanMathSpans(text, { atCaret: true }).at(-1);
  if (!span || span.to !== text.length) return null;
  const equation = createEquation(block, span);
  if (!equation) return null;

  const from = $pos.start() + span.from;
  const source = `${state.doc.textBetween(from, pos)}$`;
  // Type the dollar, then replace the source with the equation, as one step
  // of history: undo takes the keystroke back along with what it did.
  const tr = state.tr.insertText("$", pos).replaceWith(from, pos + 1, equation);
  return tr.setMeta(typingKey, { from, to: from + equation.nodeSize, source, marks: equation.marks });
}

/**
 * Converts equations where text comes in: the closing `$` as it is typed, and
 * delimited source arriving in a paste.
 */
function createConversionPlugin() {
  return new Plugin<TypedEquation | null>({
    key: typingKey,
    state: {
      init: () => null,
      apply(tr, typed) {
        const meta = tr.getMeta(typingKey) as TypedEquation | undefined;
        if (meta) return meta;
        // Anything else the author does settles the conversion.
        return tr.docChanged || tr.selectionSet ? null : typed;
      },
    },
    props: {
      handleTextInput(view, from, to, text) {
        if (text !== "$" || from !== to || view.composing) return false;
        const tr = typeClosingDelimiter(view.state, from);
        if (!tr) return false;
        view.dispatch(tr);
        return true;
      },
      transformPasted(slice, view) {
        const content = convertDelimitedMath(slice.content, view.state.schema);
        return content === slice.content ? slice : new Slice(content, slice.openStart, slice.openEnd);
      },
    },
  });
}

/** Node views by their DOM, so a keyboard command can open one. */
const openViews = new WeakMap<globalThis.Node, InlineMathView>();

/**
 * An equation in the live editor, with its source editable in place.
 *
 * Opening it shows a field under the equation. Every keystroke that compiles
 * is written to the node at once — the same contract as the standalone math
 * shape — so the document never holds source and output that disagree, and
 * nothing is lost if the text editor closes before the field does. Escape
 * restores what the equation was when the field opened; emptying the field
 * removes the equation.
 */
class InlineMathView implements NodeView {
  readonly dom: HTMLElement;
  private rendered: HTMLElement;
  private editor: HTMLElement | null = null;
  /** The node's attributes as the field opened, exactly as stored, once a keystroke changed them. */
  private original: ProseMirrorNode["attrs"] | null = null;

  constructor(
    private node: ProseMirrorNode,
    private readonly view: EditorView,
    private readonly getPos: () => number | undefined,
  ) {
    this.dom = document.createElement("span");
    this.dom.className = className(styles.view);
    this.rendered = renderMathElement(node.attrs);
    this.dom.appendChild(this.rendered);
    this.dom.addEventListener("click", this.handleClick);
    openViews.set(this.dom, this);
  }

  update(node: ProseMirrorNode): boolean {
    if (node.type !== this.node.type) return false;
    if (node.attrs !== this.node.attrs) {
      const next = renderMathElement(node.attrs);
      this.rendered.replaceWith(next);
      this.rendered = next;
    }
    this.node = node;
    return true;
  }

  selectNode() {
    this.dom.classList.add(...className(styles.selected).split(" ").filter(Boolean));
  }

  deselectNode() {
    this.dom.classList.remove(...className(styles.selected).split(" ").filter(Boolean));
  }

  /** Events inside the source field are the field's, not the document's. */
  stopEvent(event: Event): boolean {
    return !!this.editor?.contains(event.target as globalThis.Node);
  }

  ignoreMutation(): boolean {
    return true;
  }

  destroy() {
    this.editor = null;
    this.dom.removeEventListener("click", this.handleClick);
    openViews.delete(this.dom);
  }

  /** Opens the source field; false when the document is not editable. */
  open(): boolean {
    if (this.editor) return true;
    if (!this.view.editable) return false;
    const attrs = normalizeMathAttrs(this.node.attrs);
    this.original = null;

    const editor = document.createElement("span");
    editor.className = className(styles.editor);
    editor.contentEditable = "false";
    const input = document.createElement("input");
    input.type = "text";
    input.className = className(styles.input);
    input.value = attrs.input;
    input.maxLength = MAX_MATH_INPUT_LENGTH;
    input.spellcheck = false;
    input.setAttribute("aria-label", "Math expression");
    const feedback = document.createElement("span");
    feedback.setAttribute("role", "status");
    editor.appendChild(input);
    editor.appendChild(feedback);

    const showFeedback = (message: string | null, isError: boolean) => {
      feedback.className = className(styles.feedback, isError ? styles.error : styles.hint);
      feedback.textContent = message ?? "Enter to finish · Esc to cancel";
    };
    showFeedback(null, false);

    input.addEventListener("input", () => {
      const result = compileMathInput(input.value, undefined, attrs.displayMode);
      showFeedback(result.error ?? result.hint, !!result.error);
      if (result.latex) this.write({ input: input.value.trim(), latex: result.latex });
    });
    input.addEventListener("keydown", (event) => {
      // The canvas listens for keys too — Escape would end the text edit.
      event.stopPropagation();
      if (event.isComposing) return;
      if (event.key === "Enter") {
        event.preventDefault();
        this.close(input.value.trim() ? "keep" : "remove", true);
      } else if (event.key === "Escape") {
        event.preventDefault();
        this.close("restore", true);
      }
    });
    input.addEventListener("blur", () => this.close(input.value.trim() ? "keep" : "remove", false));

    this.editor = editor;
    this.dom.appendChild(editor);
    input.focus();
    input.select();
    return true;
  }

  private readonly handleClick = () => {
    this.open();
  };

  /** Writes compiled source to the node, leaving the selection on it. */
  private write(attrs: Partial<MathAttrs>) {
    const pos = this.getPos();
    if (pos === undefined) return;
    this.original ??= this.node.attrs;
    this.view.dispatch(this.view.state.tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, ...attrs }));
  }

  /**
   * Closes the source field. Enter and Escape hand the caret back to the
   * document after the equation; a blur leaves it wherever the author went.
   */
  private close(outcome: "keep" | "restore" | "remove", refocus: boolean) {
    const editor = this.editor;
    if (!editor) return;
    // Cleared first: moving focus back to the document blurs the field again.
    this.editor = null;
    editor.remove();

    const pos = this.getPos();
    if (pos === undefined || this.view.isDestroyed) return;
    const tr = this.view.state.tr;
    if (outcome === "remove") {
      tr.delete(pos, pos + this.node.nodeSize);
    } else if (outcome === "restore" && this.original) {
      // Exactly as stored: a peer's equation is never rewritten just because
      // it was opened and closed here.
      tr.setNodeMarkup(pos, undefined, this.original);
    }
    if (refocus) {
      const after = outcome === "remove" ? pos : pos + this.node.nodeSize;
      tr.setSelection(TextSelection.create(tr.doc, after));
    }
    if (tr.docChanged || tr.selectionSet) this.view.dispatch(tr);
    if (refocus) this.view.focus();
  }
}
