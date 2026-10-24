// @vitest-environment jsdom
import { atom } from "@tldraw/state";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as mathInput from "./math-input";
import type { Editor, TLShapeId } from "tldraw";
import {
  createMathShapeProps,
  MATH_BASE_FONT_SIZE,
  MATH_PADDING,
  type MathShape,
} from "@orbmeet/whiteboard-core/math-shape-schema";
import { MathShapeUtil } from "./math-shape-util";
import { mathDark } from "./math-shape-theme";
import * as stylex from "@stylexjs/stylex";
import type { StyleXStyles } from "@stylexjs/stylex";

const SHAPE_ID = "shape:math-test" as TLShapeId;
const pointerStyles = stylex.create({
  interactive: { pointerEvents: "all" },
  inert: { pointerEvents: "none" },
});

function carriesPointerStyle(element: HTMLElement, style: StyleXStyles) {
  const className = stylex.props(style).className;
  return Boolean(className && element.classList.contains(className));
}

function createMathShape(props: Partial<MathShape["props"]> = {}): MathShape {
  return {
    id: SHAPE_ID,
    typeName: "shape",
    type: "math",
    x: 0,
    y: 0,
    rotation: 0,
    index: "a1",
    parentId: "page:page",
    isLocked: false,
    opacity: 1,
    meta: {},
    props: createMathShapeProps({
      input: "a/b",
      latex: "\\frac{a}{b}",
      ...props,
    }),
  } as unknown as MathShape;
}

/**
 * A minimal editor whose editing/selection state lives in signals, which is how
 * the real one behaves. tldraw's InnerShape does not re-render on these
 * changes, so the component has to subscribe to them itself.
 */
function createFakeEditor() {
  const editingShapeId = atom<TLShapeId | null>("editingShapeId", null);
  const selectedShapeIds = atom<TLShapeId[]>("selectedShapeIds", []);
  const readonly = atom("readonly", false);
  const zoom = atom("zoom", 1);
  const darkMode = atom("darkMode", false);
  const updates: Array<Partial<MathShape["props"]>> = [];

  let shape = createMathShape();

  const editor = {
    getIsReadonly: () => readonly.get(),
    getEditingShapeId: () => editingShapeId.get(),
    getSelectedShapeIds: () => selectedShapeIds.get(),
    getZoomLevel: () => zoom.get(),
    // The shape themes itself off tldraw's colour mode rather than off the
    // `tl-theme__dark` class, which lives on a node tldraw owns.
    user: { getIsDarkMode: () => darkMode.get() },
    getShape: () => shape,
    updateShape: (partial: { props: Partial<MathShape["props"]> }) => {
      updates.push(partial.props);
      shape = {
        ...shape,
        props: { ...shape.props, ...partial.props },
      };
    },
    deleteShape: () => {},
    markEventAsHandled: () => {},
    setEditingShape: (id: TLShapeId | null) => editingShapeId.set(id),
    setCurrentTool: () => {},
    run: (fn: () => void) => fn(),
  };

  return {
    editor,
    editingShapeId,
    selectedShapeIds,
    readonly,
    zoom,
    darkMode,
    updates,
    setShape: (next: MathShape) => {
      shape = next;
    },
  };
}

function renderMathShape(shape = createMathShape()) {
  const harness = createFakeEditor();
  harness.setShape(shape);
  const util = new MathShapeUtil(harness.editor as unknown as Editor);
  // Mirrors production: tldraw's InnerShape renders whatever component()
  // returns, and does not re-render it when instance state changes.
  const { rerender } = render(util.component(shape));
  return {
    ...harness,
    // Standing in for tldraw re-rendering the shape after its record changed.
    update: (next: MathShape) => {
      harness.setShape(next);
      flushSignals(() => rerender(util.component(next)));
    },
  };
}

/**
 * jsdom has no layout. Model local dimensions separately from transformed
 * screen bounds, so zoom/rotation tests detect use of the wrong coordinates.
 */
function stubContentSize(width: number, height: number) {
  let size = { width, height };
  const widthSpy = vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(() => size.width);
  const heightSpy = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(() => size.height);
  return {
    set: (next: { width: number; height: number }) => {
      size = next;
    },
    restore: () => {
      widthSpy.mockRestore();
      heightSpy.mockRestore();
    },
  };
}

const measurements = (updates: Array<Partial<MathShape["props"]>>) =>
  updates.filter((update) => update.w !== undefined);

/**
 * act() returns a thenable even when the update is synchronous; we only need
 * the flush, so the result is intentionally discarded in one place.
 */
function flushSignals(update: () => void) {
  void act(update);
}

const mathContainer = () =>
  document.querySelector('[data-testid="math-shape"]') as HTMLElement;
const mathEditor = () => screen.queryByLabelText("Math expression");

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("math shape editing state", () => {
  it("does not compile source when showing valid baked LaTeX", () => {
    const compile = vi.spyOn(mathInput, "compileMathInput");
    const resolve = vi.spyOn(mathInput, "resolveMathLatex");
    const shape = createMathShape({ input: 'text(")' + "(".repeat(40) + "x" + ")".repeat(40) + '"', latex: "x" });
    const { update } = renderMathShape(shape);
    expect(compile).not.toHaveBeenCalled();
    expect(resolve).toHaveBeenCalledTimes(1);
    update({ ...shape, props: { ...shape.props, w: 300 } });
    expect(compile).not.toHaveBeenCalled();
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("rejects an inline toggle that would make the equation unrenderable", () => {
    const input = String.raw`\begin{align}x&=1\end{align}`;
    const { editingShapeId, updates } = renderMathShape(createMathShape({ input, latex: input }));
    flushSignals(() => editingShapeId.set(SHAPE_ID));
    flushSignals(() => screen.getByRole("button", { name: "Display" }).click());
    expect(updates.some((update) => update.displayMode === false)).toBe(false);
    expect(screen.getByRole("status").textContent).toMatch(/display mode/);
    expect(document.querySelector(".katex")).toBeTruthy();
  });

  it("publishes a draft that becomes valid when switching to display mode", () => {
    const { editingShapeId, updates } = renderMathShape(createMathShape({ displayMode: false }));
    flushSignals(() => editingShapeId.set(SHAPE_ID));
    const input = String.raw`\begin{align}x&=1\end{align}`;
    fireEvent.change(screen.getByLabelText("Math expression"), { target: { value: input } });
    expect(updates).toEqual([]);
    flushSignals(() => screen.getByRole("button", { name: "Inline" }).click());
    expect(updates.at(-1)).toEqual({ input, latex: input, displayMode: true });
  });

  it("opens the editor when the shape starts being edited", () => {
    const { editingShapeId } = renderMathShape();

    expect(mathEditor()).toBeNull();

    flushSignals(() => editingShapeId.set(SHAPE_ID));

    expect(mathEditor()).toBeTruthy();
  });

  it("closes the editor when editing moves away", () => {
    const { editingShapeId } = renderMathShape();

    flushSignals(() => editingShapeId.set(SHAPE_ID));
    expect(mathEditor()).toBeTruthy();

    flushSignals(() => editingShapeId.set(null));

    expect(mathEditor()).toBeNull();
  });

  it("becomes interactive when the shape is selected", () => {
    const { selectedShapeIds } = renderMathShape();

    expect(carriesPointerStyle(mathContainer(), pointerStyles.inert)).toBe(true);

    flushSignals(() => selectedShapeIds.set([SHAPE_ID]));

    expect(carriesPointerStyle(mathContainer(), pointerStyles.interactive)).toBe(true);
  });

  it("stays inert for readonly participants", () => {
    const { selectedShapeIds, readonly } = renderMathShape();

    flushSignals(() => selectedShapeIds.set([SHAPE_ID]));
    expect(carriesPointerStyle(mathContainer(), pointerStyles.interactive)).toBe(true);

    flushSignals(() => readonly.set(true));
    expect(carriesPointerStyle(mathContainer(), pointerStyles.inert)).toBe(true);
  });

  /**
   * The shape cannot select on tldraw's `tl-theme__dark` class — it sits on a
   * node tldraw renders, and StyleX's contextual selectors only resolve
   * against a marker class StyleX itself generated. So the shape reads the
   * colour mode and re-themes its own subtree; this is the assertion that the
   * theme is actually reaching the DOM.
   */
  it("themes itself when tldraw switches the board to dark", () => {
    const { darkMode } = renderMathShape();
    // A theme compiles to more than one class, so check for all of them.
    const themeClasses = (stylex.props(mathDark).className ?? "").split(" ").filter(Boolean);
    const isThemed = () =>
      themeClasses.every((name) => mathContainer().classList.contains(name));

    expect(themeClasses.length).toBeGreaterThan(0);
    expect(isThemed()).toBe(false);

    flushSignals(() => darkMode.set(true));
    expect(isThemed()).toBe(true);

    flushSignals(() => darkMode.set(false));
    expect(isThemed()).toBe(false);
  });

  it("renders a local fallback when nothing has been baked yet", () => {
    renderMathShape(createMathShape({ input: "a/b", latex: "" }));
    expect(document.querySelector(".katex")).toBeTruthy();
  });

  it("renders malformed legacy output locally without synchronizing a repair", () => {
    const { updates } = renderMathShape(
      createMathShape({ input: "a/b", latex: "\\badcmd" }),
    );

    expect(document.querySelector(".katex")).toBeTruthy();
    expect(updates).toEqual([]);
  });

  it("switches between display and inline math from the editor", () => {
    // Delimiters set this on conversion; a shape made from the toolbar has no
    // other way to become inline.
    const { editingShapeId, updates, update } = renderMathShape();
    flushSignals(() => editingShapeId.set(SHAPE_ID));

    const toggle = screen.getByRole("button", { name: "Display" });
    flushSignals(() => toggle.click());

    expect(updates.at(-1)).toEqual({ displayMode: false });

    update(createMathShape({ displayMode: false }));
    expect(screen.getByRole("button", { name: "Inline" })).toBeTruthy();
  });

  it("synchronizes valid source and LaTeX atomically", () => {
    const { editingShapeId, updates } = renderMathShape();
    flushSignals(() => editingShapeId.set(SHAPE_ID));

    fireEvent.change(screen.getByLabelText("Math expression"), {
      target: { value: "x^2" },
    });

    expect(updates.at(-1)).toEqual({ input: "x^2", latex: "x^{2}" });
  });

  it("does not reselect the expression when synchronized input changes", () => {
    const { editingShapeId, update } = renderMathShape();
    flushSignals(() => editingShapeId.set(SHAPE_ID));

    const editor = screen.getByLabelText<HTMLTextAreaElement>("Math expression");
    fireEvent.change(editor, { target: { value: "x^2" } });
    editor.setSelectionRange(3, 3);

    update(createMathShape({ input: "x^2", latex: "x^{2}" }));

    expect(editor.selectionStart).toBe(3);
    expect(editor.selectionEnd).toBe(3);
  });

  it("keeps invalid draft text out of the synchronized shape", () => {
    const { editingShapeId, updates } = renderMathShape();
    flushSignals(() => editingShapeId.set(SHAPE_ID));

    fireEvent.change(screen.getByLabelText("Math expression"), {
      target: { value: "\\badcmd" },
    });

    expect(
      screen.getByLabelText<HTMLTextAreaElement>("Math expression").value,
    ).toBe("\\badcmd");
    expect(updates.some((update) => update.input === "\\badcmd")).toBe(false);

    flushSignals(() => editingShapeId.set(null));
    expect(mathEditor()).toBeNull();
  });

  it("clears both synchronized fields so an empty shape can be removed", () => {
    const { editingShapeId, updates } = renderMathShape();
    flushSignals(() => editingShapeId.set(SHAPE_ID));

    fireEvent.change(screen.getByLabelText("Math expression"), {
      target: { value: "" },
    });

    expect(updates.at(-1)).toEqual({ input: "", latex: "" });
  });

  it("does not offer the toggle to readonly participants", () => {
    const { editingShapeId, readonly, updates } = renderMathShape();
    flushSignals(() => readonly.set(true));
    flushSignals(() => editingShapeId.set(SHAPE_ID));

    screen.queryByRole("button", { name: "Display" })?.click();

    expect(updates.some((update) => "displayMode" in update)).toBe(false);
  });
});

describe("math shape sizing", () => {
  it("sizes the box from the measured equation", () => {
    const stub = stubContentSize(200, 60);
    try {
      const { updates } = renderMathShape();

      expect(measurements(updates).at(-1)).toEqual({
        w: 200 + MATH_PADDING * 2,
        h: 60 + MATH_PADDING * 2,
      });
    } finally {
      stub.restore();
    }
  });

  it("does not write a measurement for readonly participants", () => {
    const stub = stubContentSize(200, 60);
    try {
      const harness = createFakeEditor();
      harness.readonly.set(true);
      const util = new MathShapeUtil(harness.editor as unknown as Editor);
      render(util.component(createMathShape()));

      expect(measurements(harness.updates)).toEqual([]);
    } finally {
      stub.restore();
    }
  });

  it("leaves an unrendered shape at its default box", () => {
    // Measuring the "Type a math expression" placeholder would size an empty
    // shape to a sentence, then snap it down on the first keystroke.
    const stub = stubContentSize(380, 34);
    try {
      const { updates } = renderMathShape(createMathShape({ input: "", latex: "" }));

      expect(measurements(updates)).toEqual([]);
    } finally {
      stub.restore();
    }
  });

  it("scales the rendered equation with the scale prop", () => {
    renderMathShape(createMathShape({ scale: 2 }));
    const preview = document.querySelector('[data-testid="math-preview"]') as HTMLElement;

    expect(preview.getAttribute("style")).toContain(`${MATH_BASE_FONT_SIZE * 2}px`);
  });

  it("re-measures the box after a resize scales the equation", () => {
    // The font size that drives the rendered size lives on an ancestor, so
    // nothing about the equation's own markup changes when scale does. Without
    // re-measuring, the box would stay put and clip the larger equation.
    const stub = stubContentSize(200, 60);
    try {
      const { updates, update } = renderMathShape(createMathShape({ scale: 1 }));
      expect(measurements(updates).at(-1)).toEqual({ w: 240, h: 100 });

      stub.set({ width: 400, height: 120 });
      update(createMathShape({ scale: 2, w: 240, h: 100 }));

      expect(measurements(updates).at(-1)).toEqual({
        w: 400 + MATH_PADDING * 2,
        h: 120 + MATH_PADDING * 2,
      });
    } finally {
      stub.restore();
    }
  });

  it("measures in page units, not the measuring peer's zoom", () => {
    // getBoundingClientRect reports screen pixels and tldraw scales the shape
    // layer by the camera zoom, so a peer at 200% would otherwise write a box
    // twice the size of the equation into the shared record.
    const stub = stubContentSize(200, 60);
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({ width: 400, height: 120 } as DOMRect);
    try {
      const harness = createFakeEditor();
      harness.zoom.set(2);
      const util = new MathShapeUtil(harness.editor as unknown as Editor);
      render(util.component(createMathShape()));

      expect(measurements(harness.updates).at(-1)).toEqual({
        w: 200 + MATH_PADDING * 2,
        h: 60 + MATH_PADDING * 2,
      });
    } finally {
      stub.restore();
    }
  });

  it("keeps local dimensions when rotated 90 degrees", () => {
    const stub = stubContentSize(200, 60);
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({ width: 60, height: 200 } as DOMRect);
    try {
      const { updates } = renderMathShape({ ...createMathShape(), rotation: Math.PI / 2 });
      expect(measurements(updates).at(-1)).toEqual({ w: 240, h: 100 });
    } finally { stub.restore(); }
  });
});
