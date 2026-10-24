// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { Editor, generateHTML, generateText } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import { NodeSelection } from "@tiptap/pm/state";
import { INLINE_MATH_NODE } from "./inline-math-extension";
import { MAX_MATH_INPUT_LENGTH, MAX_MATH_LATEX_LENGTH } from "./math-input";
import { WHITEBOARD_TIPTAP_EXTENSIONS } from "../../editor/tldraw-options";

// The exact list the board runs with, so the rules are exercised alongside
// every default that could interfere with them.
const extensions = WHITEBOARD_TIPTAP_EXTENSIONS;

/**
 * Types text one character at a time through ProseMirror's text-input path,
 * dispatching each keystroke as its own transaction the way a browser does.
 */
function typeInto(editor: Editor, text: string) {
  for (const character of text) {
    const { from, to } = editor.state.selection;
    // ProseMirror hands handlers the transaction it would apply itself, and
    // falls back to it when no handler claims the keystroke.
    const insert = () => editor.state.tr.insertText(character, from, to);
    const handled = editor.view.someProp(
      "handleTextInput",
      (fn) => fn?.(editor.view, from, to, character, insert) ?? false,
    );
    if (!handled) editor.view.dispatch(insert());
  }
}

/**
 * The attributes this extension owns. tldraw's TextDirection extension stamps a
 * `dir` onto every node in the document, which is none of our business.
 */
function mathNodes(editor: Editor) {
  const found: Array<Record<string, unknown>> = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name !== INLINE_MATH_NODE) return;
    const { input, latex, displayMode } = node.attrs;
    found.push({ input, latex, displayMode });
  });
  return found;
}

// Editors must be destroyed so ProseMirror's DOMObserver cancels its flush
// timers; otherwise a timer fires after jsdom tears down and throws
// `document is not defined`.
const editors: Editor[] = [];
function createEditor(content?: string) {
  const editor = new Editor({
    extensions,
    element: document.createElement("div"),
    content,
  });
  editors.push(editor);
  return editor;
}

afterEach(() => {
  while (editors.length) editors.pop()!.destroy();
});

// ProseMirror's `pasteText` builds a paste event; jsdom has no ClipboardEvent.
globalThis.ClipboardEvent ??= class extends Event {
  readonly clipboardData = null;
} as unknown as typeof ClipboardEvent;

const text = (editor: Editor) => generateText(editor.getJSON(), extensions);

/** Presses a key through ProseMirror's key handling, falling back to the browser's own edit. */
function press(editor: Editor, key: string) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true });
  const handled = editor.view.someProp("handleKeyDown", (fn) => fn(editor.view, event));
  if (handled || (key !== "Backspace" && key !== "Delete")) return;
  const { selection } = editor.state;
  if (!selection.empty) editor.view.dispatch(editor.state.tr.deleteSelection());
  else if (key === "Backspace") editor.view.dispatch(editor.state.tr.delete(selection.from - 1, selection.from));
  else editor.view.dispatch(editor.state.tr.delete(selection.from, selection.from + 1));
}

/** The source field of the equation being edited in place, if one is open. */
const sourceField = (editor: Editor) => editor.view.dom.querySelector<HTMLInputElement>("input");

function editSource(field: HTMLInputElement, value: string) {
  field.value = value;
  field.dispatchEvent(new Event("input"));
}

const keyIn = (field: HTMLInputElement, key: string) =>
  field.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));

describe("typing inline math", () => {
  it("converts an equation on its closing dollar", () => {
    const editor = createEditor();
    typeInto(editor, "Let's do some math: $x^2");
    expect(mathNodes(editor)).toEqual([]);

    typeInto(editor, "$");
    expect(mathNodes(editor)).toEqual([{ input: "x^2", latex: "x^{2}", displayMode: false }]);
    typeInto(editor, " and then some");
    expect(text(editor)).toBe("Let's do some math: $x^2$ and then some");
  });

  it("leaves prices as prose", () => {
    for (const prose of ["It cost $5 and $10 ", "between $5-$10 a month", "$20,000 and $30,000 "]) {
      const editor = createEditor();
      typeInto(editor, prose);
      expect(mathNodes(editor)).toEqual([]);
      expect(text(editor)).toBe(prose);
    }
  });

  it("reads $$…$$ as display math without stranding a dollar", () => {
    const editor = createEditor();
    typeInto(editor, "$$x^2$$ ");
    expect(mathNodes(editor)).toEqual([{ input: "x^2", latex: "x^{2}", displayMode: true }]);
    expect(text(editor)).toBe("$$x^2$$ ");
  });

  it("types an equation straight after another one", () => {
    const editor = createEditor();
    typeInto(editor, "$a$$b$");
    expect(mathNodes(editor).map((node) => node.input)).toEqual(["a", "b"]);
  });

  it("keeps escaped dollars inside LaTeX and round-trips through HTML", () => {
    const editor = createEditor();
    typeInto(editor, String.raw`before $\$5x$ after`);
    expect(mathNodes(editor)).toEqual([{ input: String.raw`\$5x`, latex: String.raw`\$5x`, displayMode: false }]);
    expect(text(editor)).toBe(String.raw`before $\$5x$ after`);
    expect(mathNodes(createEditor(editor.getHTML()))).toEqual(mathNodes(editor));
  });

  it("does not close an expression on an escaped dollar", () => {
    const editor = createEditor();
    typeInto(editor, String.raw`$x+\$ `);
    expect(mathNodes(editor)).toEqual([]);
  });

  it("keeps a quoted dollar inside display AsciiMath", () => {
    const editor = createEditor();
    typeInto(editor, '$$"$5"$$ ');
    expect(mathNodes(editor)).toEqual([{ input: '"$5"', latex: "\\text{\\$5}", displayMode: true }]);
    expect(text(editor)).toBe('$$"$5"$$ ');
  });

  it("keeps display-only LaTeX editable when typed with inline delimiters", () => {
    const editor = createEditor();
    const input = String.raw`$\begin{align}x&=1\end{align}$ `;
    typeInto(editor, input);
    expect(mathNodes(editor)).toEqual([]);
    expect(text(editor)).toBe(input);
    const display = createEditor();
    typeInto(display, `$${input.trimEnd()}$ `);
    expect(mathNodes(display)).toHaveLength(1);
    expect(display.getHTML()).not.toContain('data-math-pending="true"');
  });

  it("renders math padded with spaces inside the delimiters", () => {
    // `$ x^2 $` is spaced on both sides — the shape of deliberate padding, not
    // the `$5 and $` money transient.
    const editor = createEditor();
    typeInto(editor, "there it is $ (2015+10)^2 = 2025 $ ");
    expect(mathNodes(editor)).toEqual([
      {
        input: "(2015+10)^2 = 2025",
        latex: "\\left ( 2015 + 10 \\right )^{2} = 2025",
        displayMode: false,
      },
    ]);
  });

  it("leaves math that cannot render as editable text", () => {
    // `\badcmd` is an undefined control sequence: KaTeX will never render it,
    // so it stays as text the author can fix rather than a locked atom.
    const editor = createEditor();
    typeInto(editor, "before $\\badcmd$ after");
    expect(mathNodes(editor)).toEqual([]);
    expect(text(editor)).toBe("before $\\badcmd$ after");
  });

  it("leaves pathologically nested math as text instead of freezing", () => {
    const editor = createEditor();
    typeInto(editor, "$" + "(".repeat(40) + "x" + ")".repeat(40) + "$ ");
    expect(mathNodes(editor)).toEqual([]);
  });

  it("leaves dollars typed in inline code alone, before and after it closes", () => {
    const editor = createEditor();
    typeInto(editor, "run `echo $a$ b` done");
    expect(mathNodes(editor)).toEqual([]);
    expect(editor.getJSON().content?.[0]?.content).toContainEqual(
      expect.objectContaining({ text: "echo $a$ b", marks: [{ type: "code" }] }),
    );

    const code = createEditor("<p><code>$x</code></p>");
    code.commands.setTextSelection(4);
    typeInto(code, "$");
    expect(mathNodes(code)).toEqual([]);
  });

  it("never pairs a dollar in inline code with one outside it", () => {
    const editor = createEditor("<p>run <code>echo $ </code>then</p>");
    editor.commands.focus("end");
    // ` then ` is padded on both sides, so the code's dollar would close here.
    typeInto(editor, " $x$");
    expect(mathNodes(editor)).toEqual([{ input: "x", latex: "x", displayMode: false }]);
  });

  it("keeps the formatting the equation was typed in", () => {
    const editor = createEditor("<p><strong>bold </strong></p>");
    editor.commands.focus("end");
    typeInto(editor, "$x$");
    expect(editor.getJSON().content?.[0]?.content?.at(-1)).toMatchObject({
      type: INLINE_MATH_NODE,
      marks: [{ type: "bold" }],
    });
  });
});

describe("taking a conversion back", () => {
  it("restores the typed source when Backspace follows the closing dollar", () => {
    const editor = createEditor();
    typeInto(editor, "it costs $x$");
    expect(mathNodes(editor)).toHaveLength(1);

    press(editor, "Backspace");
    expect(mathNodes(editor)).toEqual([]);
    expect(text(editor)).toBe("it costs $x$");
    typeInto(editor, "5");
    expect(text(editor)).toBe("it costs $x$5");
    expect(mathNodes(editor)).toEqual([]);
  });

  it("only takes back the conversion just made", () => {
    const editor = createEditor();
    typeInto(editor, "so $x^2$ ");
    press(editor, "Backspace");
    // The space settled the equation: Backspace now selects it, then deletes it.
    press(editor, "Backspace");
    expect(mathNodes(editor)).toHaveLength(1);
    expect(editor.state.selection).toBeInstanceOf(NodeSelection);

    press(editor, "Backspace");
    expect(mathNodes(editor)).toEqual([]);
    expect(text(editor)).toBe("so ");
  });

  it("selects the equation ahead on Delete", () => {
    const editor = createEditor();
    typeInto(editor, "$x$ ");
    editor.commands.setTextSelection(1);
    press(editor, "Delete");
    expect(editor.state.selection).toBeInstanceOf(NodeSelection);
    expect(mathNodes(editor)).toHaveLength(1);
  });

  it("undoes the closing keystroke together with its conversion", () => {
    const editor = createEditor();
    typeInto(editor, "so $x^2");
    editor.view.dispatch(closeHistory(editor.state.tr));
    typeInto(editor, "$");
    expect(mathNodes(editor)).toHaveLength(1);

    editor.commands.undo();
    expect(mathNodes(editor)).toEqual([]);
    expect(text(editor)).toBe("so $x^2");
  });
});

describe("pasting inline math", () => {
  it("converts equations in pasted text, wherever the caret ends up", () => {
    const editor = createEditor();
    editor.view.pasteText("the area is $\\pi r^2$ exactly");
    expect(mathNodes(editor)).toEqual([{ input: "\\pi r^2", latex: "\\pi r^2", displayMode: false }]);

    const lone = createEditor();
    lone.view.pasteText("$x^2$");
    expect(mathNodes(lone)).toEqual([{ input: "x^2", latex: "x^{2}", displayMode: false }]);
  });

  it("round-trips through plain text back into an equation", () => {
    const editor = createEditor();
    typeInto(editor, "so $x^2$ and $$y$$ ");
    const pasted = createEditor();
    pasted.view.pasteText(text(editor));
    expect(mathNodes(pasted)).toEqual(mathNodes(editor));
  });

  it("leaves pasted inline code alone and keeps pasted formatting", () => {
    const editor = createEditor();
    editor.view.pasteHTML("<p><code>$a$</code> <strong>b $x$</strong></p>");
    expect(mathNodes(editor)).toEqual([{ input: "x", latex: "x", displayMode: false }]);
    expect(editor.getJSON().content?.[0]?.content?.at(-1)).toMatchObject({
      type: INLINE_MATH_NODE,
      marks: [{ type: "bold" }],
    });
  });
});

describe("editing an equation in place", () => {
  function equationSelected(source = "$x^2$ ") {
    const editor = createEditor();
    typeInto(editor, `so ${source}`);
    editor.commands.setNodeSelection(4);
    return editor;
  }

  it("opens the source on Enter and writes each compiling keystroke", () => {
    const editor = equationSelected();
    press(editor, "Enter");
    const field = sourceField(editor)!;
    expect(field.value).toBe("x^2");

    editSource(field, "x^3");
    expect(mathNodes(editor)).toEqual([{ input: "x^3", latex: "x^{3}", displayMode: false }]);
    editSource(field, "\\badcmd");
    expect(mathNodes(editor)).toEqual([{ input: "x^3", latex: "x^{3}", displayMode: false }]);
    expect(field.parentElement?.textContent).toContain("badcmd");

    keyIn(field, "Enter");
    expect(sourceField(editor)).toBeNull();
    expect(editor.state.selection.from).toBe(5);
    expect(text(editor)).toBe("so $x^3$ ");
  });

  it("opens the source when the equation is clicked", () => {
    const editor = equationSelected();
    editor.view.dom.querySelector(".orbmeet-inline-math")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(sourceField(editor)?.value).toBe("x^2");
  });

  it("restores the equation on Escape", () => {
    const editor = equationSelected();
    press(editor, "Enter");
    const field = sourceField(editor)!;
    editSource(field, "y");
    keyIn(field, "Escape");
    expect(sourceField(editor)).toBeNull();
    expect(mathNodes(editor)).toEqual([{ input: "x^2", latex: "x^{2}", displayMode: false }]);
  });

  it("leaves a peer's stored attributes untouched when closed unchanged", () => {
    const editor = createEditor(
      '<p>so <span data-math-input="x^2" data-math-latex="x^{2}">x</span></p>',
    );
    editor.commands.setNodeSelection(4);
    const before = editor.state.doc;
    press(editor, "Enter");
    keyIn(sourceField(editor)!, "Escape");
    expect(editor.state.doc.eq(before)).toBe(true);
  });

  it("removes the equation when its source is emptied", () => {
    const editor = equationSelected();
    press(editor, "Enter");
    const field = sourceField(editor)!;
    editSource(field, "  ");
    keyIn(field, "Enter");
    expect(mathNodes(editor)).toEqual([]);
    expect(text(editor)).toBe("so  ");
  });

  it("keeps display math in display mode", () => {
    const editor = equationSelected("$$x$$ ");
    press(editor, "Enter");
    editSource(sourceField(editor)!, "y");
    expect(mathNodes(editor)).toEqual([{ input: "y", latex: "y", displayMode: true }]);
  });

  it("does not open for a reader", () => {
    const editor = equationSelected();
    editor.setEditable(false);
    editor.view.dom.querySelector(".orbmeet-inline-math")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(sourceField(editor)).toBeNull();
  });
});

describe("inline math rendering", () => {
  it("clamps over-long attributes arriving as pasted HTML", () => {
    // A crafted span can carry anything; the node bounds it to the same limits
    // the typed and stored paths enforce.
    const hugeLatex = "\\alpha ".repeat(MAX_MATH_LATEX_LENGTH);
    const html = `<span data-math-input="x" data-math-latex="${hugeLatex}">x</span>`;
    const editor = createEditor(html);

    const [node] = mathNodes(editor);
    expect((node.input as string).length).toBeLessThanOrEqual(
      MAX_MATH_INPUT_LENGTH,
    );
    expect((node.latex as string).length).toBeLessThanOrEqual(
      MAX_MATH_LATEX_LENGTH,
    );
  });

  it("rebuilds invalid pasted LaTeX from its bounded source", () => {
    const editor = createEditor(
      '<span data-math-input="x^2" data-math-latex="\\badcmd">x</span>',
    );

    expect(mathNodes(editor)).toEqual([
      { input: "x^2", latex: "x^{2}", displayMode: false },
    ]);
  });

  it("bounds synchronized JSON again before rendering it", () => {
    const hugeInput = "i".repeat(MAX_MATH_INPUT_LENGTH + 10_000);
    const hugeLatex = "L".repeat(MAX_MATH_LATEX_LENGTH + 10_000);
    const html = generateHTML(
      {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: INLINE_MATH_NODE,
                attrs: {
                  input: hugeInput,
                  latex: hugeLatex,
                  displayMode: false,
                },
              },
            ],
          },
        ],
      },
      extensions,
    );

    expect(html).not.toContain(hugeInput);
    expect(html).not.toContain(hugeLatex);
    expect(html).not.toMatch(/\s(?:input|latex|displaymode)=/i);
    const document = new DOMParser().parseFromString(html, "text/html");
    expect(
      document.querySelector("[data-math-input]")?.getAttribute("data-math-input")
        ?.length,
    ).toBe(MAX_MATH_INPUT_LENGTH);
  });

  it("renders through KaTeX for the canvas and for export", () => {
    const editor = createEditor();
    typeInto(editor, "$x^2$ ");

    // Canvas and SVG export both go through generateHTML, so this is the one
    // path that has to produce real markup.
    const html = generateHTML(editor.getJSON(), extensions);
    expect(html).toContain("katex");
    expect(html).toContain("msup");
    expect(html).toContain('data-math-input="x^2"');
  });

});
