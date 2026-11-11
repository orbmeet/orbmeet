// @vitest-environment jsdom
import { cleanup, createEvent, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useWhiteboardImageImport } from "./use-whiteboard-image-import";

// The board as synced-whiteboard wires it, around a stand-in for tldraw's
// canvas, which stops a drop from bubbling once it has taken it.
function Board() {
  const { isDraggingOver, handleDragOver, handleDragLeave, handleDrop } = useWhiteboardImageImport({
    editor: null,
    canEditWhiteboard: true,
    navigator: null,
    onPagesChanged: () => {},
  });
  return (
    <div>
      <div
        data-testid="board"
        data-over={String(isDraggingOver)}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDropCapture={handleDrop}
      >
        <div data-testid="canvas" onDrop={(e) => e.stopPropagation()}>
          <div data-testid="shape" />
        </div>
      </div>
      <div data-testid="outside" />
    </div>
  );
}

const files = { dataTransfer: { types: ["Files"] } };

/** A `dragleave` from `from`, heading for `to` (null: out of the window, or cancelled). */
function leave(from: Element, to: Element | null) {
  const event = createEvent.dragLeave(from);
  Object.defineProperty(event, "relatedTarget", { value: to });
  fireEvent(from, event);
}

function setUp() {
  render(<Board />);
  const board = screen.getByTestId("board");
  fireEvent.dragOver(screen.getByTestId("shape"), files);
  expect(board.dataset.over).toBe("true");
  return { board, canvas: screen.getByTestId("canvas"), shape: screen.getByTestId("shape") };
}

describe("the drop overlay", () => {
  afterEach(cleanup);

  it("stays while the drag moves between the board's own elements", () => {
    const { board, canvas, shape } = setUp();
    leave(shape, canvas);
    expect(board.dataset.over).toBe("true");
  });

  it("goes when the drag leaves the board", () => {
    const { board, shape } = setUp();
    leave(shape, screen.getByTestId("outside"));
    expect(board.dataset.over).toBe("false");
  });

  it("goes when a desktop file is dragged out of the window, or the drag is cancelled", () => {
    const { board, shape } = setUp();
    leave(shape, null);
    expect(board.dataset.over).toBe("false");
  });

  it("goes on a drop the canvas keeps to itself", () => {
    const { board, shape } = setUp();
    fireEvent.drop(shape, files);
    expect(board.dataset.over).toBe("false");
  });
});
