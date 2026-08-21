/**
 * Pure grid geometry for the sheet surface.
 *
 * Everything the grid needs to know about *where* a cell is lives here: column
 * widths, row heights, cumulative offsets, and the viewport rectangle of a
 * given cell. Nothing in this module reads the DOM, `window`, or a virtualizer
 * — the shell measures the scroll container once and passes the numbers in.
 *
 * This exists because the old surface located a cell by
 * `querySelector('[data-cell=...]')`. Once rows are virtualized the element for
 * an off-screen cell does not exist, so a DOM lookup silently returns null for
 * exactly the cells that need positioning most (the one being edited while the
 * user scrolls, the current find match). Computing the rect arithmetically is
 * both correct off-screen and cheaper on-screen.
 */

import { columnKeyFromIndex, type SheetData } from '@pagespace/lib/sheets/sheet';
import type { EditorCellRect } from './layout';

/** Fallback column width in px when the sheet defines none. */
export const DEFAULT_COLUMN_WIDTH = 112;
/** Fallback row height in px when the sheet defines none. */
export const DEFAULT_ROW_HEIGHT = 32;
/** Width of the row-number gutter. */
export const ROW_HEADER_WIDTH = 48;
/** Height of the column-letter strip. */
export const COLUMN_HEADER_HEIGHT = 32;

/**
 * Bounds applied when *reading* a stored size. Storage stays faithful to
 * whatever was written (an import may carry a 3px column); the clamp happens
 * here, at the point of use, so a save never rewrites the user's numbers.
 */
export const MIN_COLUMN_WIDTH = 24;
export const MAX_COLUMN_WIDTH = 1000;
export const MIN_ROW_HEIGHT = 16;
export const MAX_ROW_HEIGHT = 500;

/** Row-height presets for the density control. */
export const DENSITY_ROW_HEIGHTS = {
  compact: 26,
  normal: DEFAULT_ROW_HEIGHT,
  relaxed: 40,
} as const;

export type GridDensity = keyof typeof DENSITY_ROW_HEIGHTS;

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

/**
 * A resolved axis: `offsets[i]` is the start position of index `i`, and the
 * array has `count + 1` entries so `offsets[count]` is the axis total. Storing
 * the prefix sum (rather than recomputing) is what makes `indexAtOffset` a
 * binary search instead of a scan.
 */
export interface AxisGeometry {
  count: number;
  offsets: number[];
  total: number;
}

/** Build an axis from a per-index size function. */
export const buildAxis = (count: number, sizeAt: (index: number) => number): AxisGeometry => {
  const safeCount = Math.max(0, Math.floor(count));
  const offsets = new Array<number>(safeCount + 1);
  let running = 0;
  for (let index = 0; index < safeCount; index++) {
    offsets[index] = running;
    running += sizeAt(index);
  }
  offsets[safeCount] = running;
  return { count: safeCount, offsets, total: running };
};

/** The size of one index; 0 for an index outside the axis. */
export const axisSize = (axis: AxisGeometry, index: number): number => {
  if (index < 0 || index >= axis.count) return 0;
  return axis.offsets[index + 1] - axis.offsets[index];
};

/** The start offset of one index, clamped to the axis ends. */
export const axisOffset = (axis: AxisGeometry, index: number): number => {
  if (index <= 0) return 0;
  if (index >= axis.count) return axis.total;
  return axis.offsets[index];
};

/**
 * The index containing `position`, clamped into the axis. Positions past the
 * end resolve to the last index rather than to `count`, so a drag beyond the
 * final row still selects a real cell.
 */
export const indexAtOffset = (axis: AxisGeometry, position: number): number => {
  if (axis.count === 0) return 0;
  if (position <= 0) return 0;
  if (position >= axis.total) return axis.count - 1;

  let low = 0;
  let high = axis.count - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (axis.offsets[mid] <= position) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return low;
};

/** The effective width of a column: stored value if usable, else the default. */
export const columnWidthAt = (sheet: Pick<SheetData, 'columnWidths'>, index: number): number => {
  const stored = sheet.columnWidths?.[columnKeyFromIndex(index)];
  if (typeof stored !== 'number' || !Number.isFinite(stored)) return DEFAULT_COLUMN_WIDTH;
  return clamp(stored, MIN_COLUMN_WIDTH, MAX_COLUMN_WIDTH);
};

/** The effective height of a row, with the density preset as the fallback. */
export const rowHeightAt = (
  sheet: Pick<SheetData, 'rowHeights'>,
  index: number,
  baseHeight: number = DEFAULT_ROW_HEIGHT,
): number => {
  const stored = sheet.rowHeights?.[String(index + 1)];
  if (typeof stored !== 'number' || !Number.isFinite(stored)) return baseHeight;
  return clamp(stored, MIN_ROW_HEIGHT, MAX_ROW_HEIGHT);
};

export const buildColumnAxis = (
  sheet: Pick<SheetData, 'columnCount' | 'columnWidths'>,
): AxisGeometry => buildAxis(sheet.columnCount, (index) => columnWidthAt(sheet, index));

export const buildRowAxis = (
  sheet: Pick<SheetData, 'rowCount' | 'rowHeights'>,
  baseHeight: number = DEFAULT_ROW_HEIGHT,
): AxisGeometry => buildAxis(sheet.rowCount, (index) => rowHeightAt(sheet, index, baseHeight));

/** How many leading indices are frozen, clamped to something renderable. */
export const frozenCount = (requested: number | undefined, axisCount: number): number => {
  if (typeof requested !== 'number' || !Number.isFinite(requested)) return 0;
  // A fully-frozen axis leaves nothing to scroll, so keep at least one free.
  return clamp(Math.floor(requested), 0, Math.max(0, axisCount - 1));
};

/** The pinned band's extent in px. */
export const frozenExtent = (axis: AxisGeometry, frozen: number): number =>
  axisOffset(axis, frozenCount(frozen, axis.count));

/**
 * What the shell measures once per scroll/resize: where the grid body starts in
 * viewport coordinates, how far it has scrolled, and how big it is.
 */
export interface GridViewportState {
  /** Viewport x of the body's left edge (i.e. after the row-number gutter). */
  bodyLeft: number;
  /** Viewport y of the body's top edge (i.e. below the column-letter strip). */
  bodyTop: number;
  /** Visible body width/height in px. */
  bodyWidth: number;
  bodyHeight: number;
  scrollLeft: number;
  scrollTop: number;
}

export interface CellRectInput {
  rowAxis: AxisGeometry;
  columnAxis: AxisGeometry;
  row: number;
  column: number;
  frozenRows?: number;
  frozenColumns?: number;
  view: GridViewportState;
}

/**
 * The viewport rectangle of a cell — what `position: fixed` overlays (the cell
 * editor, later the chart layer) need.
 *
 * Frozen cells are pinned: they ignore the scroll offset, exactly as the
 * `position: sticky` bands that render them do. Keeping both models in one
 * place is what stops the editor drifting away from its cell.
 */
export const cellViewportRect = ({
  rowAxis,
  columnAxis,
  row,
  column,
  frozenRows,
  frozenColumns,
  view,
}: CellRectInput): EditorCellRect => {
  const pinnedColumn = column < frozenCount(frozenColumns, columnAxis.count);
  const pinnedRow = row < frozenCount(frozenRows, rowAxis.count);

  return {
    left: view.bodyLeft + axisOffset(columnAxis, column) - (pinnedColumn ? 0 : view.scrollLeft),
    top: view.bodyTop + axisOffset(rowAxis, row) - (pinnedRow ? 0 : view.scrollTop),
    width: axisSize(columnAxis, column),
    height: axisSize(rowAxis, row),
  };
};

/**
 * Whether a cell is at least partly within the scrolled body. Used to decide
 * whether an overlay should be drawn — never to decide whether an edit is still
 * valid. The old surface conflated the two and cancelled the user's edit when
 * they scrolled the cell out of sight.
 */
export const isCellVisible = ({
  rowAxis,
  columnAxis,
  row,
  column,
  frozenRows,
  frozenColumns,
  view,
}: CellRectInput): boolean => {
  const rect = cellViewportRect({ rowAxis, columnAxis, row, column, frozenRows, frozenColumns, view });
  const frozenLeft = view.bodyLeft + frozenExtent(columnAxis, frozenColumns ?? 0);
  const frozenTop = view.bodyTop + frozenExtent(rowAxis, frozenRows ?? 0);

  const pinnedColumn = column < frozenCount(frozenColumns, columnAxis.count);
  const pinnedRow = row < frozenCount(frozenRows, rowAxis.count);

  // A scrolling cell that has slid under the frozen band is occluded, not
  // visible — the band paints over it.
  const leftBound = pinnedColumn ? view.bodyLeft : frozenLeft;
  const topBound = pinnedRow ? view.bodyTop : frozenTop;

  return (
    rect.left + rect.width > leftBound &&
    rect.left < view.bodyLeft + view.bodyWidth &&
    rect.top + rect.height > topBound &&
    rect.top < view.bodyTop + view.bodyHeight
  );
};

/**
 * The scroll offset that brings `index` fully into view along one axis, or the
 * current offset when it already is. Scrolls the minimum distance, so arrowing
 * down a long sheet advances a row at a time instead of paging.
 *
 * The frozen band is subtracted from the usable window: without that, the
 * "revealed" cell lands underneath the pinned band and stays invisible.
 */
export const scrollOffsetToReveal = (
  axis: AxisGeometry,
  index: number,
  currentOffset: number,
  viewportSize: number,
  frozen = 0,
): number => {
  const frozenSize = frozenExtent(axis, frozen);
  if (index < frozenCount(frozen, axis.count)) return currentOffset;

  const usable = viewportSize - frozenSize;
  if (usable <= 0) return currentOffset;

  const start = axisOffset(axis, index);
  const end = start + axisSize(axis, index);

  // Too far up/left: align the cell's start to the edge of the free region.
  if (start - currentOffset < frozenSize) {
    return Math.max(0, start - frozenSize);
  }
  // Too far down/right: align its end to the far edge.
  if (end - currentOffset > viewportSize) {
    return Math.max(0, end - viewportSize);
  }
  return currentOffset;
};

/** The inclusive index range intersecting a scrolled window, with overscan. */
export const visibleRange = (
  axis: AxisGeometry,
  scrollOffset: number,
  viewportSize: number,
  overscan = 0,
): { start: number; end: number } => {
  if (axis.count === 0) return { start: 0, end: -1 };
  const start = Math.max(0, indexAtOffset(axis, scrollOffset) - overscan);
  const end = Math.min(axis.count - 1, indexAtOffset(axis, scrollOffset + viewportSize) + overscan);
  return { start, end };
};
