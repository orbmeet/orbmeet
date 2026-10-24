import { renderToStaticMarkup } from "react-dom/server";
import { Box, Vec, type Editor, type SvgExportContext } from "tldraw";
import { describe, expect, it } from "vitest";
import {
  clampTableSize,
  getNextTableCell,
  getTableRowLayout,
  normalizeTableCellText,
  resizeCells,
  TableShapeUtil,
} from "./table-shape-util";
import {
  MAX_TABLE_HEIGHT,
  MAX_TABLE_CELL_CHARS,
  MAX_TABLE_WIDTH,
  TABLE_HEADER_HEIGHT,
  TABLE_SHAPE_MIGRATIONS,
  TABLE_SHAPE_PROPS,
  type TableShape,
} from "@orbmeet/whiteboard-core/table-shape-schema";

function createTableShape(props: Partial<TableShape["props"]> = {}): TableShape {
  return {
    id: "shape:table-test",
    typeName: "shape",
    type: "table",
    x: 10,
    y: 20,
    rotation: 0,
    index: "a1",
    parentId: "page:page",
    isLocked: false,
    opacity: 1,
    meta: {},
    props: {
      w: 360,
      h: 200,
      cells: [
        ["Name", "Status", "Owner"],
        ["Export", "Ready", "Ada"],
        ["Tests", "Passing", "Lin"],
      ],
      headerRow: true,
      ...props,
    },
  } as TableShape;
}

describe("normalizeTableCellText", () => {
  it("preserves ASCII operators as ordinary text", () => {
    expect(normalizeTableCellText("x -> y")).toBe("x -> y");
    expect(normalizeTableCellText("x <= y")).toBe("x <= y");
    expect(normalizeTableCellText("A && B")).toBe("A && B");
    expect(normalizeTableCellText("A || B")).toBe("A || B");
    expect(normalizeTableCellText("~(A -> B)")).toBe("~(A -> B)");
  });

  it("still enforces the table-cell character limit", () => {
    const value = "x".repeat(MAX_TABLE_CELL_CHARS + 10);
    expect(normalizeTableCellText(value)).toHaveLength(MAX_TABLE_CELL_CHARS);
  });
});

describe("table grid invariants", () => {
  it("accepts only non-empty rectangular cell grids", () => {
    expect(TABLE_SHAPE_PROPS.cells.isValid([["a", "b"], ["c", "d"]])).toBe(true);
    expect(TABLE_SHAPE_PROPS.cells.isValid([])).toBe(false);
    expect(TABLE_SHAPE_PROPS.cells.isValid([[]])).toBe(false);
    expect(TABLE_SHAPE_PROPS.cells.isValid([["a", "b"], ["c"]])).toBe(false);
  });

  it("resizes malformed input into a valid grid while preserving data", () => {
    expect(resizeCells([["a"], ["b", "c"]], 2, 3)).toEqual([
      ["a", "", ""],
      ["b", "c", ""],
    ]);
  });

  it("migrates dimensions into the cell grid and can downgrade again", () => {
    const props: Record<string, unknown> = {
      w: 40,
      h: 20,
      rows: 2,
      cols: 3,
      cells: [["kept"]],
      headerRow: true,
    };
    const migration = TABLE_SHAPE_MIGRATIONS.sequence[1];
    if (!("up" in migration)) throw new Error("Expected table props migration");
    migration.up(props);

    expect(props).toMatchObject({
      w: 120,
      h: 56,
      cells: [["kept", "", ""], ["", "", ""]],
      headerRow: true,
    });
    expect(props).not.toHaveProperty("rows");
    expect(props).not.toHaveProperty("cols");

    const down = migration.down;
    expect(typeof down).toBe("function");
    if (typeof down === "function") down(props);
    expect(props).toMatchObject({ rows: 2, cols: 3 });
  });
});

describe("table sizing", () => {
  it("enforces header-aware minimums and absolute maximums", () => {
    expect(clampTableSize(1, 1, 2, 3, true)).toEqual({ w: 120, h: 56 });
    expect(clampTableSize(Infinity, Infinity, 2, 3, true)).toEqual({
      w: MAX_TABLE_WIDTH,
      h: MAX_TABLE_HEIGHT,
    });
  });

  it("uses resizeBox so clamped left-edge resizing stays anchored", () => {
    const shape = createTableShape();
    const util = new TableShapeUtil({} as Editor);
    const resized = util.onResize(shape, {
      newPoint: new Vec(300, 20),
      handle: "left",
      mode: "resize_bounds",
      scaleX: 0.1,
      scaleY: 1,
      initialBounds: new Box(10, 20, 360, 200),
      initialShape: shape,
    });

    expect(resized.props.w).toBe(120);
    expect(resized.x).toBe(216);
  });

  it("caps resize results at the schema maximum", () => {
    const shape = createTableShape();
    const util = new TableShapeUtil({} as Editor);
    const resized = util.onResize(shape, {
      newPoint: new Vec(10, 20),
      handle: "bottom_right",
      mode: "resize_bounds",
      scaleX: 100,
      scaleY: 100,
      initialBounds: new Box(10, 20, 360, 200),
      initialShape: shape,
    });

    expect(resized.props).toMatchObject({
      w: MAX_TABLE_WIDTH,
      h: MAX_TABLE_HEIGHT,
    });
  });
});

describe("table keyboard navigation", () => {
  it("moves between cells but releases Tab at the grid boundaries", () => {
    expect(getNextTableCell("Tab", false, 0, 2, 2, 3)).toEqual({ row: 1, col: 0 });
    expect(getNextTableCell("Tab", true, 1, 0, 2, 3)).toEqual({ row: 0, col: 2 });
    expect(getNextTableCell("Tab", false, 1, 2, 2, 3)).toBeNull();
    expect(getNextTableCell("Tab", true, 0, 0, 2, 3)).toBeNull();
  });
});

describe("table export", () => {
  it("renders cells as static SVG without editing controls", () => {
    const util = new TableShapeUtil({} as Editor);
    const markup = renderToStaticMarkup(
      util.toSvg(createTableShape(), {} as SvgExportContext),
    );

    expect(markup).toContain("Name");
    expect(markup).toContain("Export");
    expect(markup).toContain("<text");
    expect(markup).not.toContain("<input");
    expect(markup).not.toContain("Edit cells");
  });
});

describe("table row layout", () => {
  it("gives the header its fixed height and shares the rest among body rows", () => {
    const layout = getTableRowLayout(3, true, 232);
    expect([0, 1, 2].map(layout.rowTop)).toEqual([0, TABLE_HEADER_HEIGHT, TABLE_HEADER_HEIGHT + 100]);
    expect([0, 1, 2].map(layout.rowHeight)).toEqual([TABLE_HEADER_HEIGHT, 100, 100]);
  });

  it("lets a header row on its own fill the table, as the live table lays it out", () => {
    const layout = getTableRowLayout(1, true, 66);
    expect(layout.rowTop(0)).toBe(0);
    expect(layout.rowHeight(0)).toBe(66);
  });

  it("shares the table equally among rows without a header", () => {
    const layout = getTableRowLayout(4, false, 200);
    expect([0, 1, 2, 3].map(layout.rowTop)).toEqual([0, 50, 100, 150]);
    expect(layout.rowHeight(3)).toBe(50);
  });
});
