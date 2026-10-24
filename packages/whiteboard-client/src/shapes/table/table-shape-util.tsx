import {
  BaseBoxShapeUtil,
  HTMLContainer,
  RecordProps,
  resizeBox,
  useValue,
  type Editor,
  type SvgExportContext,
  type TLResizeInfo,
} from "tldraw";
import { useCallback, useEffect, useRef } from "react";
import {
  DEFAULT_TABLE_COLS,
  DEFAULT_TABLE_HEIGHT,
  DEFAULT_TABLE_ROWS,
  DEFAULT_TABLE_WIDTH,
  MAX_TABLE_CELL_CHARS,
  MAX_TABLE_COLS,
  MAX_TABLE_HEIGHT,
  MAX_TABLE_ROWS,
  MAX_TABLE_WIDTH,
  TABLE_SHAPE_PROPS,
  TABLE_SHAPE_MIGRATIONS,
  TABLE_SHAPE_TYPE,
  TABLE_HEADER_HEIGHT,
  getMinimumTableHeight,
  getMinimumTableWidth,
  type TableShape,
} from "@orbmeet/whiteboard-core/table-shape-schema";
import { danger, neutral, surface } from "@orbmeet/ui/tokens/colors.stylex";
import { shadows } from "@orbmeet/ui/tokens/shadows.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";
import { env } from "@orbmeet/ui/tokens/media.stylex";

// Shape colours are intentionally fixed to the exported SVG palette. Keeping
// them as constants makes the live HTML and its portable export agree.
const accentBlue = "#3b82f6";
const accentBlueSurface = "#eff6ff";

const styles = stylex.create({
  shape: {
    position: "relative",
    overflow: "visible",
    boxSizing: "border-box",
    borderRadius: "6px",
    backgroundColor: surface.raised,
    fontFamily: "ui-sans-serif, system-ui, -apple-system, sans-serif",
    fontSize: "13px",
  },
  size: (width: number, height: number) => ({ width, height }),
  table: {
    width: "100%",
    height: "100%",
    tableLayout: "fixed",
    overflow: "hidden",
    borderCollapse: "collapse",
    borderRadius: "6px",
    outlineWidth: 1,
    outlineStyle: "solid",
    outlineColor: neutral.n300,
    outlineOffset: -1,
  },
  cell: {
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: neutral.n300,
    padding: 0,
    textAlign: "center",
    verticalAlign: "middle",
  },
  headerCell: { backgroundColor: neutral.n100 },
  cellSize: (width: number, height: number) => ({ width, height }),
  value: {
    width: "100%",
    height: "100%",
    boxSizing: "border-box",
    paddingInline: space.s1_5,
    paddingBlock: space.s0_5,
    fontWeight: weight.normal,
  },
  headerValue: { fontWeight: weight.semibold },
  input: {
    borderWidth: 0,
    outlineWidth: { default: 0, ":focus": 2 },
    outlineStyle: "solid",
    outlineColor: accentBlue,
    outlineOffset: -2,
    borderRadius: { default: 0, ":focus": "2px" },
    backgroundColor: { default: "transparent", ":focus": accentBlueSurface },
    fontFamily: "inherit",
    textAlign: "center",
  },
  display: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  controls: {
    position: "absolute",
    top: "calc(100% + 6px)",
    left: -1,
    zIndex: 10,
    display: "flex",
    gap: space.s1,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: neutral.n200,
    borderRadius: "6px",
    backgroundColor: `color-mix(in oklab, ${surface.raised} 96%, transparent)`,
    padding: space.s1,
    boxShadow: shadows.popover,
  },
  control: {
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: neutral.n300,
    borderRadius: "4px",
    backgroundColor: { default: neutral.n100, [env.hoverable]: { default: neutral.n100, ":hover": neutral.n200 } },
    paddingInline: space.s2,
    paddingBlock: "3px",
    color: neutral.n700,
    fontSize: "11px",
    lineHeight: 1.4,
    fontWeight: weight.medium,
    whiteSpace: "nowrap",
    cursor: "pointer",
  },
  destructiveControl: {
    color: danger.d600,
    backgroundColor: { default: neutral.n100, [env.hoverable]: { default: neutral.n100, ":hover": danger.d100 } },
  },
  interactive: { pointerEvents: "all" },
  inert: { pointerEvents: "none" },
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeEmptyCells(rows: number, cols: number): string[][] {
  return Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => "")
  );
}

function clampRows(rows: number): number {
  return Math.max(1, Math.min(MAX_TABLE_ROWS, Math.trunc(rows)));
}

function clampCols(cols: number): number {
  return Math.max(1, Math.min(MAX_TABLE_COLS, Math.trunc(cols)));
}

export function clampTableSize(
  width: number,
  height: number,
  rows: number,
  cols: number,
  headerRow: boolean,
) {
  return {
    w: Math.max(getMinimumTableWidth(cols), Math.min(MAX_TABLE_WIDTH, width)),
    h: Math.max(
      getMinimumTableHeight(rows, headerRow),
      Math.min(MAX_TABLE_HEIGHT, height),
    ),
  };
}

function getTableGridSize(cells: string[][]): { rows: number; cols: number } {
  return { rows: cells.length, cols: cells[0]?.length ?? 0 };
}

export function getNextTableCell(
  key: "Tab" | "ArrowDown" | "ArrowUp" | "ArrowRight" | "ArrowLeft",
  shiftKey: boolean,
  row: number,
  col: number,
  rows: number,
  cols: number,
): { row: number; col: number } | null {
  let nextRow = row;
  let nextCol = col;

  if (key === "Tab") {
    nextCol += shiftKey ? -1 : 1;
    if (nextCol < 0) {
      nextCol = cols - 1;
      nextRow -= 1;
    } else if (nextCol >= cols) {
      nextCol = 0;
      nextRow += 1;
    }
  } else if (key === "ArrowDown") {
    nextRow += 1;
  } else if (key === "ArrowUp") {
    nextRow -= 1;
  } else if (key === "ArrowRight") {
    nextCol += 1;
  } else {
    nextCol -= 1;
  }

  return nextRow >= 0 && nextRow < rows && nextCol >= 0 && nextCol < cols
    ? { row: nextRow, col: nextCol }
    : null;
}

export function normalizeTableCellText(value: string): string {
  return value.slice(0, MAX_TABLE_CELL_CHARS);
}

/** Resize or pad a cell grid to fit new dimensions, preserving existing data. */
export function resizeCells(
  existing: string[][],
  newRows: number,
  newCols: number
): string[][] {
  const rows = clampRows(newRows);
  const cols = clampCols(newCols);
  return Array.from({ length: rows }, (_, r) =>
    Array.from({ length: cols }, (_, c) =>
      normalizeTableCellText(existing[r]?.[c] ?? "")
    )
  );
}

function normalizeTableBounds(shape: TableShape): TableShape {
  const { rows, cols } = getTableGridSize(shape.props.cells);
  const size = clampTableSize(
    shape.props.w,
    shape.props.h,
    rows,
    cols,
    shape.props.headerRow,
  );
  if (size.w === shape.props.w && size.h === shape.props.h) return shape;
  return { ...shape, props: { ...shape.props, ...size } };
}

/**
 * Where each row sits, shared by the live table and its SVG export so the two
 * cannot draw the same table differently.
 *
 * A header keeps its fixed height while there are body rows to take the rest
 * of the table; a header row on its own fills the table, as the browser lays
 * out a single row, and with no header every row gets an equal share.
 */
export function getTableRowLayout(
  rows: number,
  headerRow: boolean,
  height: number,
): { rowTop: (row: number) => number; rowHeight: (row: number) => number } {
  if (headerRow && rows > 1) {
    const bodyRowHeight = (height - TABLE_HEADER_HEIGHT) / (rows - 1);
    return {
      rowTop: (row) => (row === 0 ? 0 : TABLE_HEADER_HEIGHT + (row - 1) * bodyRowHeight),
      rowHeight: (row) => (row === 0 ? TABLE_HEADER_HEIGHT : bodyRowHeight),
    };
  }
  const rowHeight = height / Math.max(1, rows);
  return { rowTop: (row) => row * rowHeight, rowHeight: () => rowHeight };
}

function renderTableSvg(shape: TableShape) {
  const { cells, headerRow, w, h } = shape.props;
  const { rows, cols } = getTableGridSize(cells);
  const colWidth = w / cols;
  const layout = getTableRowLayout(rows, headerRow, h);
  const idPrefix = `table-export-${shape.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;

  return (
    <g>
      <defs>
        <clipPath id={`${idPrefix}-outline`}>
          <rect width={w} height={h} rx={6} />
        </clipPath>
      </defs>
      <g clipPath={`url(#${idPrefix}-outline)`}>
        <rect width={w} height={h} fill="#ffffff" />
        {cells.map((row, rowIndex) => {
          const isHeader = headerRow && rowIndex === 0;
          const rowHeight = layout.rowHeight(rowIndex);
          const y = layout.rowTop(rowIndex);

          return row.map((cell, colIndex) => {
            const x = colIndex * colWidth;
            const textClipId = `${idPrefix}-text-${rowIndex}-${colIndex}`;
            return (
              <g key={`${rowIndex}-${colIndex}`}>
                <defs>
                  <clipPath id={textClipId}>
                    <rect
                      x={x + 6}
                      y={y + 1}
                      width={Math.max(0, colWidth - 12)}
                      height={Math.max(0, rowHeight - 2)}
                    />
                  </clipPath>
                </defs>
                <rect
                  x={x}
                  y={y}
                  width={colWidth}
                  height={rowHeight}
                  fill={isHeader ? "#f4f4f5" : "#ffffff"}
                  stroke="#d4d4d8"
                />
                <text
                  x={x + colWidth / 2}
                  y={y + rowHeight / 2}
                  clipPath={`url(#${textClipId})`}
                  dominantBaseline="central"
                  fill="#18181b"
                  fontFamily="ui-sans-serif, system-ui, sans-serif"
                  fontSize={13}
                  fontWeight={isHeader ? 600 : 400}
                  textAnchor="middle"
                >
                  {cell}
                </text>
              </g>
            );
          });
        })}
      </g>
      <rect
        width={w}
        height={h}
        rx={6}
        fill="none"
        stroke="#d4d4d8"
      />
    </g>
  );
}

// ─── Component ──────────────────────────────────────────────────────────────

function TableComponent({
  shape,
  isEditing,
  showControls,
  onCellChange,
  onAddRow,
  onAddCol,
  onRemoveRow,
  onRemoveCol,
  onToggleHeader,
  onEdit,
}: {
  shape: TableShape;
  isEditing: boolean;
  showControls: boolean;
  onCellChange: (row: number, col: number, value: string) => void;
  onAddRow: () => void;
  onAddCol: () => void;
  onRemoveRow: () => void;
  onRemoveCol: () => void;
  onToggleHeader: () => void;
  onEdit: () => void;
}) {
  const { cells, headerRow, w, h } = shape.props;
  const { rows, cols } = getTableGridSize(cells);
  const cellRefs = useRef<(HTMLInputElement | null)[][]>([]);

  // Auto-focus the first cell when entering edit mode
  useEffect(() => {
    if (isEditing && cellRefs.current[0]?.[0]) {
      cellRefs.current[0][0].focus();
    }
  }, [isEditing]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent, row: number, col: number) => {
      if (e.shiftKey && e.key.startsWith("Arrow")) return;
      const isHorizontalBoundary =
        e.currentTarget instanceof HTMLInputElement &&
        ((e.key === "ArrowRight" && e.currentTarget.selectionStart === e.currentTarget.value.length) ||
          (e.key === "ArrowLeft" && e.currentTarget.selectionStart === 0));
      if (
        e.key !== "Tab" &&
        e.key !== "ArrowDown" &&
        e.key !== "ArrowUp" &&
        !isHorizontalBoundary
      ) {
        return;
      }

      const next = getNextTableCell(
        e.key as "Tab" | "ArrowDown" | "ArrowUp" | "ArrowRight" | "ArrowLeft",
        e.shiftKey,
        row,
        col,
        rows,
        cols,
      );
      if (next) {
        if (e.key === "Tab") e.preventDefault();
        cellRefs.current[next.row]?.[next.col]?.focus();
      }
    },
    [rows, cols]
  );

  const colWidth = w / cols;
  const layout = getTableRowLayout(rows, headerRow, h);

  return (
    <div {...stylex.props(styles.shape, styles.size(w, h))}>
      <table {...stylex.props(styles.table)}>
        <tbody>
          {Array.from({ length: rows }, (_, r) => (
            <tr key={r}>
              {Array.from({ length: cols }, (_, c) => {
                const isHeader = headerRow && r === 0;
                const Tag = isHeader ? "th" : "td";
                return (
                  <Tag
                    key={c}
                    {...stylex.props(
                      styles.cell,
                      isHeader && styles.headerCell,
                      styles.cellSize(colWidth, layout.rowHeight(r)),
                    )}
                  >
                    {isEditing ? (
                      <input
                        ref={(el) => {
                          if (!cellRefs.current[r]) cellRefs.current[r] = [];
                          cellRefs.current[r][c] = el;
                        }}
                        type="text"
                        {...stylex.props(
                          styles.value,
                          styles.input,
                          isHeader && styles.headerValue,
                        )}
                        aria-label={`Row ${r + 1}, column ${c + 1}`}
                        value={cells[r]?.[c] ?? ""}
                        onChange={(e) =>
                          onCellChange(r, c, normalizeTableCellText(e.target.value))
                        }
                        onKeyDown={(e) => handleKeyDown(e, r, c)}
                      />
                    ) : (
                      <span
                        {...stylex.props(
                          styles.value,
                          styles.display,
                          isHeader && styles.headerValue,
                        )}
                      >
                        {cells[r]?.[c] ?? ""}
                      </span>
                    )}
                  </Tag>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>

      {/* Row/column controls visible only while editing */}
      {showControls && (
        <div {...stylex.props(styles.controls)} onPointerDown={(e) => e.stopPropagation()}>
          {!isEditing && (
            <button
              type="button"
              {...stylex.props(styles.control)}
              onClick={onEdit}
              title="Edit table cells"
            >
              Edit cells
            </button>
          )}
          <button
            type="button"
            {...stylex.props(styles.control)}
            onClick={onToggleHeader}
            title={headerRow ? "Turn off header row" : "Turn on header row"}
          >
            {headerRow ? "Header on" : "Header off"}
          </button>
          <button
            type="button"
            {...stylex.props(styles.control)}
            onClick={onAddRow}
            title="Add row"
          >
            + Row
          </button>
          <button
            type="button"
            {...stylex.props(styles.control)}
            onClick={onAddCol}
            title="Add column"
          >
            + Col
          </button>
          {rows > 1 && (
            <button
              type="button"
              {...stylex.props(styles.control, styles.destructiveControl)}
              onClick={onRemoveRow}
              title="Remove last row"
            >
              - Row
            </button>
          )}
          {cols > 1 && (
            <button
              type="button"
              {...stylex.props(styles.control, styles.destructiveControl)}
              onClick={onRemoveCol}
              title="Remove last column"
            >
              - Col
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function TableShapeComponent({
  editor,
  shape,
}: {
  editor: Editor;
  shape: TableShape;
}) {
  const isReadonly = useValue(
    "table shape readonly",
    () => editor.getIsReadonly(),
    [editor]
  );
  // Editing and selection live in editor instance state, not the shape record.
  // tldraw's InnerShape only re-renders when props/meta change and its
  // useStateTracking scope ends when `component()` returns, so a plain read
  // here would be captured once and then go stale.
  const isEditing = useValue(
    "table shape editing",
    () => editor.getEditingShapeId() === shape.id,
    [editor, shape.id]
  );
  const isSelected = useValue(
    "table shape selected",
    () => editor.getSelectedShapeIds().includes(shape.id),
    [editor, shape.id]
  );
  const isInteractive = !isReadonly && (isEditing || isSelected);

  const updateTableProps = (props: Partial<TableShape["props"]>) => {
    if (isReadonly) return;
    editor.updateShape<TableShape>({
      id: shape.id,
      type: shape.type,
      props,
    });
  };

  const handleCellChange = (row: number, col: number, value: string) => {
    const newCells = shape.props.cells.map((r, ri) =>
      r.map((c, ci) => (ri === row && ci === col ? value : c))
    );
    updateTableProps({ cells: newCells });
  };

  const handleAddRow = () => {
    const { cells, w, h, headerRow } = shape.props;
    const { rows, cols } = getTableGridSize(cells);
    const nextRows = clampRows(rows + 1);
    if (nextRows === rows) return;
    updateTableProps({
      cells: resizeCells(cells, nextRows, cols),
      ...clampTableSize(w, h + h / rows, nextRows, cols, headerRow),
    });
  };

  const handleAddCol = () => {
    const { cells, w, h, headerRow } = shape.props;
    const { rows, cols } = getTableGridSize(cells);
    const nextCols = clampCols(cols + 1);
    if (nextCols === cols) return;
    updateTableProps({
      cells: resizeCells(cells, rows, nextCols),
      ...clampTableSize(w + w / cols, h, rows, nextCols, headerRow),
    });
  };

  const handleRemoveRow = () => {
    const { cells, w, h, headerRow } = shape.props;
    const { rows, cols } = getTableGridSize(cells);
    if (rows <= 1) return;
    const nextRows = rows - 1;
    updateTableProps({
      cells: resizeCells(cells, nextRows, cols),
      ...clampTableSize(w, h - h / rows, nextRows, cols, headerRow),
    });
  };

  const handleRemoveCol = () => {
    const { cells, w, h, headerRow } = shape.props;
    const { rows, cols } = getTableGridSize(cells);
    if (cols <= 1) return;
    const nextCols = cols - 1;
    updateTableProps({
      cells: resizeCells(cells, rows, nextCols),
      ...clampTableSize(w - w / cols, h, rows, nextCols, headerRow),
    });
  };

  const handleToggleHeader = () => {
    const { cells, w, h, headerRow } = shape.props;
    const { rows, cols } = getTableGridSize(cells);
    const nextHeaderRow = !headerRow;
    updateTableProps({
      headerRow: nextHeaderRow,
      ...clampTableSize(w, h, rows, cols, nextHeaderRow),
    });
  };

  const handleEdit = () => {
    if (isReadonly) return;
    editor.setEditingShape(shape.id);
  };

  return (
    <HTMLContainer
      id={shape.id}
      // Only swallow pointer events while the user is actively editing
      // cells. When the shape is merely selected we let pointer events
      // bubble so the editor can detect a double-click and enter edit
      // mode (otherwise users have to click the "Edit cells" button).
      onPointerDown={isEditing ? (e) => editor.markEventAsHandled(e) : undefined}
      {...stylex.props(
        styles.size(shape.props.w, shape.props.h),
        isInteractive ? styles.interactive : styles.inert,
      )}
    >
      <TableComponent
        shape={shape}
        isEditing={isEditing}
        showControls={isInteractive}
        onCellChange={handleCellChange}
        onAddRow={handleAddRow}
        onAddCol={handleAddCol}
        onRemoveRow={handleRemoveRow}
        onRemoveCol={handleRemoveCol}
        onToggleHeader={handleToggleHeader}
        onEdit={handleEdit}
      />
    </HTMLContainer>
  );
}

// ─── ShapeUtil ──────────────────────────────────────────────────────────────

export class TableShapeUtil extends BaseBoxShapeUtil<TableShape> {
  static override type = TABLE_SHAPE_TYPE;
  static override props: RecordProps<TableShape> = TABLE_SHAPE_PROPS;
  static override migrations = TABLE_SHAPE_MIGRATIONS;

  override canEdit(): boolean {
    return true;
  }

  override canResize(): boolean {
    return true;
  }

  getDefaultProps(): TableShape["props"] {
    return {
      w: DEFAULT_TABLE_WIDTH,
      h: DEFAULT_TABLE_HEIGHT,
      cells: makeEmptyCells(DEFAULT_TABLE_ROWS, DEFAULT_TABLE_COLS),
      headerRow: true,
    };
  }

  override onBeforeCreate(shape: TableShape) {
    return normalizeTableBounds(shape);
  }

  override onBeforeUpdate(_previous: TableShape, next: TableShape) {
    return normalizeTableBounds(next);
  }

  component(shape: TableShape) {
    return <TableShapeComponent editor={this.editor} shape={shape} />;
  }

  override getIndicatorPath(shape: TableShape) {
    const path = new Path2D();
    path.rect(0, 0, shape.props.w, shape.props.h);
    return path;
  }

  override getAriaDescriptor(shape: TableShape): string {
    const { rows, cols } = getTableGridSize(shape.props.cells);
    return `${rows} row by ${cols} column table`;
  }

  override toSvg(shape: TableShape, _context: SvgExportContext) {
    return renderTableSvg(shape);
  }

  override onResize(shape: TableShape, info: TLResizeInfo<TableShape>) {
    const { rows, cols } = getTableGridSize(shape.props.cells);
    return resizeBox(shape, info, {
      minWidth: getMinimumTableWidth(cols),
      maxWidth: MAX_TABLE_WIDTH,
      minHeight: getMinimumTableHeight(rows, shape.props.headerRow),
      maxHeight: MAX_TABLE_HEIGHT,
    });
  }
}
