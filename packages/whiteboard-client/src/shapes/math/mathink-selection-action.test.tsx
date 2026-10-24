// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  addToast: vi.fn(),
  recognize: vi.fn(),
  isSelectionCurrent: vi.fn(() => true),
  place: vi.fn(),
  promotable: vi.fn((): unknown => null),
  promote: vi.fn(),
}));

const selection = {
  shapeIds: ["shape:ink"],
  sourceShapes: [{ shape: { id: "shape:ink", type: "draw" } }],
  parentId: "page:page",
  strokes: [[[0, 0], [10, 10]]],
  bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
};

const editor = {
  getSelectedShapeIds: vi.fn(() => ["shape:ink"]),
  getSelectionPageBounds: vi.fn(() => ({ minX: 0, minY: 0, maxX: 10, maxY: 10 })),
  pageToViewport: vi.fn((point: { x: number; y: number }) => point),
  isIn: vi.fn(() => true),
  deleteShapes: vi.fn(),
  getOnlySelectedShape: vi.fn(() => ({ id: "shape:ink" })),
  getIsReadonly: vi.fn(() => false),
};

vi.mock("tldraw", async (importOriginal) => {
  const actual = await importOriginal<typeof import("tldraw")>();
  return {
    ...actual,
    useEditor: () => editor,
    useValue: (_name: string, getValue: () => unknown) => getValue(),
  };
});

vi.mock("./mathink", () => ({
  canRecognizeSelectedInk: () => true,
  collectSelectedMathInk: () => ({ ok: true, selection }),
  isMathInkSelectionCurrent: mocks.isSelectionCurrent,
  mathInkInputFromLatex: (latex: string) => latex,
  placeMathInkRecognition: mocks.place,
  recognizeMathInk: mocks.recognize,
  repairIncompleteMathInkLatex: (latex: string) => ({ latex, repaired: false }),
}));

vi.mock("./math-text-shapes", () => ({
  getPromotableEquation: mocks.promotable,
  promoteToMathShape: mocks.promote,
}));

vi.mock("../../chrome/use-whiteboard-toast", () => ({
  useWhiteboardToast: () => mocks.addToast,
}));

import { WhiteboardSelectionActions } from "./mathink-selection-action";

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isSelectionCurrent.mockReturnValue(true);
  mocks.promotable.mockReturnValue(null);
  editor.getIsReadonly.mockReturnValue(false);
});

describe("WhiteboardSelectionActions promotion", () => {
  const promoteButton = () => screen.queryByRole("button", { name: /into a math shape/i });

  it("offers to turn a text shape holding one equation into a math shape", () => {
    mocks.promotable.mockReturnValue({ input: "x", latex: "x", displayMode: false });
    render(<WhiteboardSelectionActions />);

    fireEvent.click(promoteButton()!);
    expect(mocks.promote).toHaveBeenCalledWith(editor, "shape:ink");
  });

  it("offers nothing for other selections or for readers", () => {
    render(<WhiteboardSelectionActions />);
    expect(promoteButton()).toBeNull();
    cleanup();

    mocks.promotable.mockReturnValue({ input: "x", latex: "x", displayMode: false });
    editor.getIsReadonly.mockReturnValue(true);
    render(<WhiteboardSelectionActions />);
    expect(promoteButton()).toBeNull();
  });
});

describe("WhiteboardSelectionActions concurrency", () => {
  it("discards a response when the selected ink changed while recognition ran", async () => {
    let resolveRecognition!: (value: {
      latex: string;
      modelStep: number;
      latencyMs: number;
    }) => void;
    mocks.recognize.mockImplementation(
      () => new Promise((resolve) => {
        resolveRecognition = resolve;
      }),
    );
    render(<WhiteboardSelectionActions />);

    fireEvent.click(screen.getByRole("button", { name: /convert selected handwriting/i }));
    mocks.isSelectionCurrent.mockReturnValue(false);
    await act(async () => {
      resolveRecognition({ latex: "x", modelStep: 70_000, latencyMs: 100 });
    });

    await waitFor(() =>
      expect(mocks.addToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Handwriting changed" }),
      ),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mocks.place).not.toHaveBeenCalled();
  });

  it("aborts the active request when the overlay unmounts", () => {
    let requestSignal: AbortSignal | undefined;
    mocks.recognize.mockImplementation(
      (_strokes: unknown, options: { signal?: AbortSignal }) => {
        requestSignal = options.signal;
        return new Promise(() => {});
      },
    );
    const view = render(<WhiteboardSelectionActions />);

    fireEvent.click(screen.getByRole("button", { name: /convert selected handwriting/i }));
    expect(requestSignal?.aborted).toBe(false);

    view.unmount();
    expect(requestSignal?.aborted).toBe(true);
  });

  it("keeps deletion available while recognition is pending", () => {
    mocks.recognize.mockImplementation(() => new Promise(() => {}));
    render(<WhiteboardSelectionActions />);

    fireEvent.click(screen.getByRole("button", { name: /convert selected handwriting/i }));
    fireEvent.click(screen.getByRole("button", { name: "Delete selection" }));

    expect(editor.deleteShapes).toHaveBeenCalledWith(["shape:ink"]);
  });

  it("surfaces a stale-placement refusal without reporting success", async () => {
    mocks.recognize.mockResolvedValue({ latex: "x", modelStep: 70_000, latencyMs: 100 });
    mocks.place.mockImplementation(() => {
      throw new Error("The selected handwriting changed. Run MathInk again before placing it.");
    });
    render(<WhiteboardSelectionActions />);

    fireEvent.click(screen.getByRole("button", { name: /convert selected handwriting/i }));
    await screen.findByRole("dialog", { name: "Convert handwriting to math" });
    fireEvent.click(screen.getByRole("button", { name: "Replace ink" }));

    expect(mocks.addToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Could not place math",
        description: expect.stringContaining("changed"),
      }),
    );
    expect(mocks.addToast).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: "Handwriting converted" }),
    );
  });
});
