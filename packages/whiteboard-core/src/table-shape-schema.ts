import { clampFinite } from "@orbmeet/primitives";
import {
  createShapePropsMigrationIds,
  createShapePropsMigrationSequence,
  type TLShape,
} from "@tldraw/tlschema";
import { T } from "@tldraw/validate";

export const TABLE_SHAPE_TYPE = "table" as const;
export const DEFAULT_TABLE_ROWS = 3;
export const DEFAULT_TABLE_COLS = 3;
export const DEFAULT_TABLE_WIDTH = 360;
export const DEFAULT_TABLE_HEIGHT = 200;
export const MIN_TABLE_COL_WIDTH = 40;
export const MIN_TABLE_ROW_HEIGHT = 24;
export const TABLE_HEADER_HEIGHT = 32;
export const MAX_TABLE_WIDTH = 20_000;
export const MAX_TABLE_HEIGHT = 20_000;
export const MAX_TABLE_ROWS = 30;
export const MAX_TABLE_COLS = 30;
export const MAX_TABLE_CELL_CHARS = 500;
export const MAX_TABLE_CELLS = MAX_TABLE_ROWS * MAX_TABLE_COLS;

export function getMinimumTableWidth(columnCount: number): number {
  return columnCount * MIN_TABLE_COL_WIDTH;
}

export function getMinimumTableHeight(rowCount: number, headerRow: boolean): number {
  if (!headerRow) return rowCount * MIN_TABLE_ROW_HEIGHT;
  return TABLE_HEADER_HEIGHT + Math.max(0, rowCount - 1) * MIN_TABLE_ROW_HEIGHT;
}

export interface TableShapeProps {
  w: number;
  h: number;
  cells: string[][];
  headerRow: boolean;
}

declare module "@tldraw/tlschema" {
  export interface TLGlobalShapePropsMap {
    [TABLE_SHAPE_TYPE]: TableShapeProps;
  }
}

export type TableShape = TLShape<typeof TABLE_SHAPE_TYPE>;

const boundedPositiveNumber = (label: string, max: number) =>
  T.number.check(label, (value) => {
    if (!Number.isFinite(value) || value < 1 || value > max) {
      throw new Error(`Expected ${label} to be in range 1..${max}`);
    }
  });

const boundedCellText = T.string.check("table cell text", (value) => {
  if (value.length > MAX_TABLE_CELL_CHARS) {
    throw new Error(`Expected table cell text to be at most ${MAX_TABLE_CELL_CHARS} characters`);
  }
});

const boundedCells = T.arrayOf(T.arrayOf(boundedCellText)).check("table cells", (rows) => {
  if (rows.length < 1 || rows.length > MAX_TABLE_ROWS) {
    throw new Error(`Expected 1..${MAX_TABLE_ROWS} table rows`);
  }

  const columnCount = rows[0]?.length ?? 0;
  if (columnCount < 1 || columnCount > MAX_TABLE_COLS) {
    throw new Error(`Expected 1..${MAX_TABLE_COLS} table columns`);
  }

  for (const row of rows) {
    if (row.length !== columnCount) {
      throw new Error("Expected every table row to have the same number of columns");
    }
  }

  if (rows.length * columnCount > MAX_TABLE_CELLS) {
    throw new Error(`Expected at most ${MAX_TABLE_CELLS} table cells`);
  }
});

export const TABLE_SHAPE_PROPS = {
  w: boundedPositiveNumber("table width", MAX_TABLE_WIDTH),
  h: boundedPositiveNumber("table height", MAX_TABLE_HEIGHT),
  cells: boundedCells,
  headerRow: T.boolean,
};

function clampInteger(value: unknown, fallback: number, max: number): number {
  return clampFinite(typeof value === "number" ? Math.trunc(value) : value, 1, max, fallback);
}

function normalizeMigratedCells(value: unknown, rows: number, cols: number): string[][] {
  const source = Array.isArray(value) ? value : [];
  return Array.from({ length: rows }, (_, rowIndex) => {
    const row = Array.isArray(source[rowIndex]) ? source[rowIndex] : [];
    return Array.from({ length: cols }, (_, colIndex) => {
      const cell = row[colIndex];
      return typeof cell === "string"
        ? cell.slice(0, MAX_TABLE_CELL_CHARS)
        : "";
    });
  });
}

const tableShapeVersions = createShapePropsMigrationIds(TABLE_SHAPE_TYPE, {
  NormalizeGrid: 1,
  DeriveDimensionsFromGrid: 2,
});

export const TABLE_SHAPE_MIGRATIONS = createShapePropsMigrationSequence({
  sequence: [
    {
      id: tableShapeVersions.NormalizeGrid,
      up(props) {
        const rows = clampInteger(props.rows, DEFAULT_TABLE_ROWS, MAX_TABLE_ROWS);
        const cols = clampInteger(props.cols, DEFAULT_TABLE_COLS, MAX_TABLE_COLS);
        props.rows = rows;
        props.cols = cols;
        props.w = clampFinite(props.w, 1, MAX_TABLE_WIDTH, DEFAULT_TABLE_WIDTH);
        props.h = clampFinite(props.h, 1, MAX_TABLE_HEIGHT, DEFAULT_TABLE_HEIGHT);
        props.headerRow = typeof props.headerRow === "boolean" ? props.headerRow : true;
        props.cells = normalizeMigratedCells(props.cells, rows, cols);
      },
    },
    {
      id: tableShapeVersions.DeriveDimensionsFromGrid,
      up(props) {
        const rows = clampInteger(props.rows, DEFAULT_TABLE_ROWS, MAX_TABLE_ROWS);
        const cols = clampInteger(props.cols, DEFAULT_TABLE_COLS, MAX_TABLE_COLS);
        props.cells = normalizeMigratedCells(props.cells, rows, cols);
        props.w = Math.max(
          getMinimumTableWidth(cols),
          clampFinite(props.w, 1, MAX_TABLE_WIDTH, DEFAULT_TABLE_WIDTH),
        );
        props.h = Math.max(
          getMinimumTableHeight(rows, props.headerRow === true),
          clampFinite(props.h, 1, MAX_TABLE_HEIGHT, DEFAULT_TABLE_HEIGHT),
        );
        delete props.rows;
        delete props.cols;
      },
      down(props) {
        const cells = Array.isArray(props.cells) ? props.cells : [];
        props.rows = clampInteger(cells.length, DEFAULT_TABLE_ROWS, MAX_TABLE_ROWS);
        props.cols = clampInteger(
          Array.isArray(cells[0]) ? cells[0].length : undefined,
          DEFAULT_TABLE_COLS,
          MAX_TABLE_COLS,
        );
      },
    },
  ],
});
