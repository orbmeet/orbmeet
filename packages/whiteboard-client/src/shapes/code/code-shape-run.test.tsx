// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Editor } from "tldraw";
import {
  CODE_SHAPE_TYPE,
  createCodeShapeProps,
  type CodeShape,
} from "@orbmeet/whiteboard-core/code-shape-schema";
import type { CodeRunResult } from "@orbmeet/whiteboard-core/code-run-contract";
import {
  WhiteboardToolbarContext,
  type WhiteboardToolbarContextValue,
} from "../../toolbar/whiteboard-toolbar-context";

const runCodeMock = vi.fn();
const cancelCodeRunMock = vi.fn();
vi.mock("./run-code", () => ({
  runCode: (...args: unknown[]) => runCodeMock(...args),
  cancelCodeRun: (...args: unknown[]) => cancelCodeRunMock(...args),
}));

const { CodeShapeUtil } = await import("./code-shape-util");

afterEach(cleanup);

const result = (overrides: Partial<CodeRunResult> = {}): CodeRunResult => ({
  status: "success",
  phase: "run",
  stdout: "42\n",
  stderr: "",
  compileStderr: "",
  exitCode: 0,
  timedOut: false,
  truncated: false,
  executionTimeMs: 7,
  ...overrides,
});

/**
 * An editor that holds one shape and answers the four signals the cell reads.
 *
 * `getShape` reflects what `updateShape` wrote, because the run's own guard
 * compares the result against the live record — a stub that never moved would
 * pass that guard no matter what the fix did.
 */
function stubEditor(
  initial: Partial<CodeShape["props"]> = {},
  options: { editing?: boolean } = {},
) {
  let shape = {
    id: "shape:code-test",
    typeName: "shape",
    type: CODE_SHAPE_TYPE,
    x: 0,
    y: 0,
    rotation: 0,
    index: "a1",
    parentId: "page:page",
    isLocked: false,
    opacity: 1,
    meta: {},
    props: { ...createCodeShapeProps(), code: "print(1)", ...initial },
  } as CodeShape;

  const updateShape = vi.fn((next: { props: Partial<CodeShape["props"]> }) => {
    shape = { ...shape, props: { ...shape.props, ...next.props } };
  });
  const setEditingShape = vi.fn();
  const setCurrentTool = vi.fn();

  const editor = {
    getIsReadonly: () => false,
    user: { getIsDarkMode: () => false },
    getSelectedShapeIds: () => ["shape:code-test"],
    getEditingShapeId: () => (options.editing ? "shape:code-test" : null),
    markEventAsHandled: () => {},
    getShape: () => shape,
    updateShape,
    setEditingShape,
    setCurrentTool,
  } as unknown as Editor;

  return {
    editor,
    updateShape,
    setEditingShape,
    setCurrentTool,
    current: () => shape,
    /** The writes that carried a result, as opposed to a source flush. */
    outputWrites: () => updateShape.mock.calls.filter(([call]) => "output" in call.props),
  };
}

function renderCell(stub: ReturnType<typeof stubEditor>) {
  const context = {
    pageManager: null,
    currentPage: 1,
    pages: [],
    canEditWhiteboard: true,
    whiteboardToken: "token",
  } as WhiteboardToolbarContextValue;

  const util = new CodeShapeUtil(stub.editor);
  const tree = () => (
    <WhiteboardToolbarContext.Provider value={context}>
      {util.component(stub.current())}
    </WhiteboardToolbarContext.Provider>
  );
  const view = render(tree());

  // tldraw renders a shape's component from the record and re-renders it when the
  // record changes. Tests that change a *prop* rather than local state have to
  // say so, or they would be asserting against a component frozen at its first
  // render.
  return { ...view, syncFromRecord: () => view.rerender(tree()) };
}

/** A run that has been started and not yet answered. */
function deferredRun() {
  let settle: (value: CodeRunResult) => void = () => {};
  const signals: (AbortSignal | undefined)[] = [];
  runCodeMock.mockImplementation((_source, _language, options) => {
    signals.push(options?.signal);
    return new Promise<CodeRunResult>((resolve) => {
      settle = resolve;
      options?.signal?.addEventListener("abort", () => resolve(result({
        status: "error",
        stderr: "aborted",
        stdout: "",
      })));
    });
  });
  return { settle: (value: CodeRunResult) => settle(value), signals };
}

beforeEach(() => {
  runCodeMock.mockReset();
  cancelCodeRunMock.mockReset();
  cancelCodeRunMock.mockResolvedValue(undefined);
});

describe("running a cell", () => {
  it("writes the result of a run whose source did not move", async () => {
    const stub = stubEditor();
    runCodeMock.mockResolvedValue(result());
    renderCell(stub);

    fireEvent.click(screen.getByRole("button", { name: /run/i }));

    await waitFor(() => expect(stub.outputWrites()).toHaveLength(1));
    expect(stub.current().props.output).toBe("42");
    expect(stub.current().props.status).toBe("success");
  });

  it("discards a result for source the author has already changed", async () => {
    // The bug this guards: the cell stays editable during a run — deliberately,
    // because a cold start takes seconds — so a result could be written as the
    // output of code that is no longer in the cell.
    const stub = stubEditor();
    const run = deferredRun();
    renderCell(stub);

    fireEvent.click(screen.getByRole("button", { name: /run/i }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "print(2)" } });
    run.settle(result({ stdout: "1\n" }));

    await waitFor(() => expect(run.signals[0]?.aborted).toBe(true));
    expect(stub.outputWrites()).toEqual([]);
    expect(stub.current().props.output).toBe("");
  });

  it("discards a result for a language the cell has since left", async () => {
    const stub = stubEditor();
    const run = deferredRun();
    const cell = renderCell(stub);

    fireEvent.click(screen.getByRole("button", { name: /run/i }));
    fireEvent.change(screen.getByLabelText("Code language"), { target: { value: "rust" } });
    cell.syncFromRecord();
    run.settle(result({ stdout: "python said this\n" }));

    await waitFor(() => expect(run.signals[0]?.aborted).toBe(true));
    expect(stub.outputWrites()).toEqual([]);
  });

  it("offers Stop while a run is in flight, and abandons it", async () => {
    const stub = stubEditor();
    const run = deferredRun();
    renderCell(stub);

    fireEvent.click(screen.getByRole("button", { name: /run/i }));
    const stop = await screen.findByRole("button", { name: /stop/i });

    fireEvent.click(stop);

    expect(run.signals[0]?.aborted).toBe(true);
    expect(cancelCodeRunMock).toHaveBeenCalledWith(expect.any(String), { token: "token" });
    await waitFor(() => expect(screen.getByRole("button", { name: /run/i })).toBeDefined());
    expect(stub.outputWrites()).toEqual([]);
  });

  it("cancels the server run when the cell unmounts", async () => {
    const stub = stubEditor();
    const run = deferredRun();
    const cell = renderCell(stub);

    fireEvent.click(screen.getByRole("button", { name: /run/i }));
    await waitFor(() => expect(run.signals).toHaveLength(1));
    cell.unmount();

    expect(run.signals[0]?.aborted).toBe(true);
    expect(cancelCodeRunMock).toHaveBeenCalledWith(expect.any(String), { token: "token" });
  });

  it("lets a second run replace the first rather than race it", async () => {
    const stub = stubEditor();
    const run = deferredRun();
    renderCell(stub);

    const textarea = screen.getByRole("textbox");
    fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(run.signals).toHaveLength(1));
    fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });

    await waitFor(() => expect(run.signals).toHaveLength(2));
    expect(run.signals[0]?.aborted).toBe(true);
    expect(run.signals[1]?.aborted).toBe(false);
  });

  it("cannot be run without a token to authenticate with", () => {
    const stub = stubEditor();
    render(
      <WhiteboardToolbarContext.Provider
        value={{
          pageManager: null,
          currentPage: 1,
          pages: [],
          canEditWhiteboard: true,
        }}
      >
        {new CodeShapeUtil(stub.editor).component(stub.current())}
      </WhiteboardToolbarContext.Provider>,
    );

    const button = screen.getByRole("button", { name: /run/i }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(runCodeMock).not.toHaveBeenCalled();
  });
});

describe("running a cell while someone else edits it", () => {
  it("runs and reports the source in front of the author", async () => {
    // While this client is editing, the record can hold a collaborator's newer
    // text with nothing of ours pending — so the source being run and the record
    // legitimately disagree before the run even starts. The run publishes what it
    // runs, which is both what the board should show and what its own check
    // against the record has to compare with.
    const stub = stubEditor({ code: "print(1)" }, { editing: true });
    runCodeMock.mockResolvedValue(result({ stdout: "1\n" }));
    const cell = renderCell(stub);

    stub.updateShape({ props: { code: "print(999)" } });
    cell.syncFromRecord();

    fireEvent.click(screen.getByRole("button", { name: /run/i }));

    await waitFor(() => expect(stub.outputWrites()).toHaveLength(1));
    expect(stub.current().props.code).toBe("print(1)");
    expect(stub.current().props.output).toBe("1");
  });
});

describe("leaving a cell", () => {
  it("returns Escape to the canvas, so the cell can be selected and deleted", () => {
    // Every key is stopped inside the textarea so that Delete edits text instead
    // of destroying the shape. That is also what keeps the editor from seeing
    // Escape, which is the only keyboard way out of the field.
    const stub = stubEditor();
    renderCell(stub);

    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });

    expect(stub.setEditingShape).toHaveBeenCalledWith(null);
    expect(stub.setCurrentTool).toHaveBeenCalledWith("select");
  });

  it("commits what was typed before leaving", () => {
    const stub = stubEditor();
    renderCell(stub);

    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "print('saved')" } });
    fireEvent.keyDown(textarea, { key: "Escape" });

    expect(stub.current().props.code).toBe("print('saved')");
  });
});
