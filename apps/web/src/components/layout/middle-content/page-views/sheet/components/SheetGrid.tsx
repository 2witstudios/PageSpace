"use client";

import React, { useCallback, useMemo } from 'react';
import { cn } from '@/lib/utils';
import {
  cellFormatToStyle,
  encodeCellAddress,
  type SheetData,
  type SheetSparseEvaluation,
} from '@pagespace/lib/sheets/sheet';
import { getColumnLabel, isCellInSelection, type GridSelection, type SelectionState } from '../core/selection';
import {
  COLUMN_HEADER_HEIGHT,
  ROW_HEADER_WIDTH,
  axisOffset,
  axisSize,
  frozenCount,
  frozenExtent,
  visibleRange,
  type AxisGeometry,
  type GridViewportState,
} from '../core/grid-metrics';
import { SheetCell, type SheetCellHandlers } from './SheetCell';

/** Extra rows/columns rendered beyond the window, so a fast scroll stays filled. */
const OVERSCAN = 4;

export interface SheetGridProps {
  gridRef: React.RefObject<HTMLDivElement | null>;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  sheet: SheetData;
  rowAxis: AxisGeometry;
  columnAxis: AxisGeometry;
  viewport: GridViewportState;
  selection: SelectionState;
  currentSelection: GridSelection;
  currentAddress: string;
  evaluation: SheetSparseEvaluation;
  editingCell: GridSelection | null;
  isReadOnly: boolean;
  findAddressSet: Set<string>;
  currentFindAddress: string | null;

  onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void;
  onSelectColumn: (column: number, event: React.MouseEvent) => void;
  onSelectRow: (row: number, event: React.MouseEvent) => void;
  onResizeColumn: (column: number, width: number) => void;
  onResizeRow: (row: number, height: number) => void;
  /** Live drag feedback; `null` ends the preview. */
  onPreviewColumnWidth: (column: number, width: number | null) => void;
  onPreviewRowHeight: (row: number, height: number | null) => void;
  onAutoFitColumn: (column: number) => void;
  handlers: SheetCellHandlers;
}

/**
 * A drag handle on a header edge.
 *
 * The drag *previews* through `onPreview` and writes to the sheet only on
 * release. Committing every pointer move would push a hundred entries onto the
 * undo stack for one drag, and Ctrl+Z would no longer undo the resize — it
 * would undo one pixel of it.
 *
 * Pointer capture keeps the drag alive when the cursor leaves the 3px handle,
 * which it does immediately.
 */
const ResizeHandle: React.FC<{
  orientation: 'column' | 'row';
  startSize: number;
  onPreview: (size: number | null) => void;
  onCommit: (size: number) => void;
  onDoubleClick?: () => void;
  label: string;
}> = ({ orientation, startSize, onPreview, onCommit, onDoubleClick, label }) => {
  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      const origin = orientation === 'column' ? event.clientX : event.clientY;
      const element = event.currentTarget;
      element.setPointerCapture(event.pointerId);

      let latest = startSize;
      const move = (moveEvent: PointerEvent) => {
        const delta = (orientation === 'column' ? moveEvent.clientX : moveEvent.clientY) - origin;
        latest = startSize + delta;
        onPreview(latest);
      };
      const finish = (commit: boolean) => {
        element.releasePointerCapture(event.pointerId);
        element.removeEventListener('pointermove', move);
        element.removeEventListener('pointerup', release);
        element.removeEventListener('pointercancel', cancel);
        onPreview(null);
        if (commit && latest !== startSize) onCommit(latest);
      };
      // A cancelled pointer (an incoming call, a gesture takeover) must drop the
      // preview rather than commit a size the user never released on.
      const release = () => finish(true);
      const cancel = () => finish(false);

      element.addEventListener('pointermove', move);
      element.addEventListener('pointerup', release);
      element.addEventListener('pointercancel', cancel);
    },
    [onCommit, onPreview, orientation, startSize],
  );

  return (
    <div
      role="separator"
      aria-orientation={orientation === 'column' ? 'vertical' : 'horizontal'}
      aria-label={label}
      // `data-hover-only` opts out of the global coarse-pointer rule that
      // force-reveals hover-hidden elements; without it every handle would sit
      // permanently visible on touch devices.
      data-hover-only
      onPointerDown={handlePointerDown}
      // `pointerdown` and `mousedown` are separate events: stopping the former
      // does not stop the latter, so without this a resize drag would also run
      // the header's select-whole-column handler.
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onDoubleClick={(event) => {
        event.stopPropagation();
        onDoubleClick?.();
      }}
      className={cn(
        'absolute z-10 opacity-0 transition-opacity hover:opacity-100',
        'bg-primary',
        orientation === 'column'
          ? 'right-0 top-0 h-full w-[3px] cursor-col-resize'
          : 'bottom-0 left-0 h-[3px] w-full cursor-row-resize',
      )}
    />
  );
};

/**
 * The spreadsheet grid: a virtualized div grid with pinnable header strips and
 * frozen panes.
 *
 * It is not a `<table>`, and cannot be: a table row cannot host
 * `transform`-positioned children, so virtualization and real column widths are
 * both off the table (literally). The ARIA tree is preserved deliberately —
 * every rendered band still emits `role="row"` wrappers around its cells, so
 * the grid reads correctly to a screen reader even though only a window of it
 * exists in the DOM at any moment.
 */
export const SheetGrid: React.FC<SheetGridProps> = ({
  gridRef,
  scrollRef,
  sheet,
  rowAxis,
  columnAxis,
  viewport,
  selection,
  currentSelection,
  currentAddress,
  evaluation,
  editingCell,
  isReadOnly,
  findAddressSet,
  currentFindAddress,
  onKeyDown,
  onSelectColumn,
  onSelectRow,
  onResizeColumn,
  onResizeRow,
  onPreviewColumnWidth,
  onPreviewRowHeight,
  onAutoFitColumn,
  handlers,
}) => {
  const frozenRows = frozenCount(sheet.frozenRows, rowAxis.count);
  const frozenColumns = frozenCount(sheet.frozenColumns, columnAxis.count);
  const frozenHeight = frozenExtent(rowAxis, frozenRows);
  const frozenWidth = frozenExtent(columnAxis, frozenColumns);

  // The scrolling window, expressed in the *free* region: the frozen bands sit
  // on top of the scroller, so the first scrollable pixel is already past them.
  const rows = useMemo(
    () =>
      visibleRange(
        rowAxis,
        viewport.scrollTop + frozenHeight,
        Math.max(0, viewport.bodyHeight - frozenHeight),
        OVERSCAN,
      ),
    [rowAxis, viewport.scrollTop, viewport.bodyHeight, frozenHeight],
  );
  const columns = useMemo(
    () =>
      visibleRange(
        columnAxis,
        viewport.scrollLeft + frozenWidth,
        Math.max(0, viewport.bodyWidth - frozenWidth),
        OVERSCAN,
      ),
    [columnAxis, viewport.scrollLeft, viewport.bodyWidth, frozenWidth],
  );

  /**
   * Render a band of cells as `role="row"` wrappers.
   *
   * `originLeft`/`originTop` shift grid coordinates into the band's own
   * coordinate space, which is what lets the frozen panes reuse this untouched.
   */
  const renderRows = useCallback(
    (
      rowStart: number,
      rowEnd: number,
      columnStart: number,
      columnEnd: number,
      originLeft: number,
      originTop: number,
    ) => {
      const output: React.ReactNode[] = [];

      for (let row = rowStart; row <= rowEnd; row++) {
        const cells: React.ReactNode[] = [];

        for (let column = columnStart; column <= columnEnd; column++) {
          const address = encodeCellAddress(row, column);
          const cell = evaluation.byAddress[address];
          const isPrimary = currentSelection.row === row && currentSelection.column === column;

          cells.push(
            <SheetCell
              key={address}
              address={address}
              row={row}
              column={column}
              left={axisOffset(columnAxis, column) - originLeft}
              top={0}
              width={axisSize(columnAxis, column)}
              height={axisSize(rowAxis, row)}
              display={cell?.error ? '#ERROR' : cell?.display ?? ''}
              hasError={!!cell?.error}
              isSelected={isCellInSelection(row, column, selection)}
              isPrimary={isPrimary}
              isEditing={!!editingCell && editingCell.row === row && editingCell.column === column}
              isFindMatch={findAddressSet.has(address)}
              isCurrentFind={currentFindAddress === address}
              // Right-alignment is the single strongest cue that a grid is a
              // spreadsheet and not a table, so numbers get it by default —
              // unless the cell's own format has an opinion.
              isNumeric={cell?.type === 'number' && !cell?.format?.align}
              wraps={!!cell?.format?.wrap}
              isReadOnly={isReadOnly}
              formatStyle={cellFormatToStyle(cell?.format) as React.CSSProperties}
              handlers={handlers}
            />,
          );
        }

        output.push(
          <div
            key={`row-${row}`}
            role="row"
            aria-rowindex={row + 1}
            style={{
              position: 'absolute',
              transform: `translate3d(0, ${axisOffset(rowAxis, row) - originTop}px, 0)`,
              height: axisSize(rowAxis, row),
              left: 0,
              right: 0,
            }}
          >
            {cells}
          </div>,
        );
      }

      return output;
    },
    [
      columnAxis,
      currentFindAddress,
      currentSelection.column,
      currentSelection.row,
      editingCell,
      evaluation.byAddress,
      findAddressSet,
      handlers,
      isReadOnly,
      rowAxis,
      selection,
    ],
  );

  const columnHeaderCells = useCallback(
    (columnStart: number, columnEnd: number, originLeft: number) => {
      const output: React.ReactNode[] = [];
      for (let column = columnStart; column <= columnEnd; column++) {
        const width = axisSize(columnAxis, column);
        const isActive =
          currentSelection.column === column || isCellInSelection(currentSelection.row, column, selection);

        output.push(
          <div
            key={`column-header-${column}`}
            role="columnheader"
            aria-colindex={column + 1}
            style={{
              position: 'absolute',
              transform: `translate3d(${axisOffset(columnAxis, column) - originLeft}px, 0, 0)`,
              width,
              height: COLUMN_HEADER_HEIGHT,
            }}
            className={cn(
              'group flex items-center justify-center border-b border-r border-[var(--separator)]',
              'text-xs font-medium select-none cursor-pointer',
              // Headers are defined by their seam, not by a grey block — the
              // convention `ui/table.tsx` sets for the rest of the product.
              isActive ? 'bg-primary/10 text-foreground' : 'text-muted-foreground hover:bg-muted/50',
            )}
            onMouseDown={(event) => onSelectColumn(column, event)}
          >
            {getColumnLabel(column)}
            <ResizeHandle
              orientation="column"
              startSize={width}
              onPreview={(size) => onPreviewColumnWidth(column, size)}
              onCommit={(size) => onResizeColumn(column, size)}
              onDoubleClick={() => onAutoFitColumn(column)}
              label={`Resize column ${getColumnLabel(column)}`}
            />
          </div>,
        );
      }
      return output;
    },
    [columnAxis, currentSelection.column, currentSelection.row, onAutoFitColumn, onPreviewColumnWidth, onResizeColumn, onSelectColumn, selection],
  );

  const rowHeaderCells = useCallback(
    (rowStart: number, rowEnd: number, originTop: number) => {
      const output: React.ReactNode[] = [];
      for (let row = rowStart; row <= rowEnd; row++) {
        const height = axisSize(rowAxis, row);
        const isActive =
          currentSelection.row === row || isCellInSelection(row, currentSelection.column, selection);

        output.push(
          <div
            key={`row-header-${row}`}
            role="rowheader"
            aria-rowindex={row + 1}
            style={{
              position: 'absolute',
              transform: `translate3d(0, ${axisOffset(rowAxis, row) - originTop}px, 0)`,
              width: ROW_HEADER_WIDTH,
              height,
            }}
            className={cn(
              'group flex items-center justify-center border-b border-r border-[var(--separator)]',
              'text-xs font-medium tabular-nums select-none cursor-pointer',
              isActive ? 'bg-primary/10 text-foreground' : 'text-muted-foreground hover:bg-muted/50',
            )}
            onMouseDown={(event) => onSelectRow(row, event)}
          >
            {row + 1}
            <ResizeHandle
              orientation="row"
              startSize={height}
              onPreview={(size) => onPreviewRowHeight(row, size)}
              onCommit={(size) => onResizeRow(row, size)}
              label={`Resize row ${row + 1}`}
            />
          </div>,
        );
      }
      return output;
    },
    [currentSelection.column, currentSelection.row, onPreviewRowHeight, onResizeRow, onSelectRow, rowAxis, selection],
  );

  const hasFrozenRows = frozenRows > 0;
  const hasFrozenColumns = frozenColumns > 0;

  /**
   * `aria-activedescendant` must name an element that exists. Only a window of
   * the grid is in the DOM, so when the user scrolls the active cell out of
   * view the id it points at is gone — and a dangling reference is worse for a
   * screen reader than none, because it reports nothing while claiming to point
   * somewhere. Navigation scrolls the active cell back into view, so this only
   * goes empty during free scrolling.
   */
  const isActiveCellRendered =
    (currentSelection.row < frozenRows ||
      (currentSelection.row >= rows.start && currentSelection.row <= rows.end)) &&
    (currentSelection.column < frozenColumns ||
      (currentSelection.column >= columns.start && currentSelection.column <= columns.end));

  /** A pinned band: clips its contents and sits above the scrolling body. */
  const bandStyle = (extra: React.CSSProperties): React.CSSProperties => ({
    position: 'absolute',
    overflow: 'hidden',
    pointerEvents: 'auto',
    ...extra,
  });

  return (
    <div
      ref={gridRef}
      role="grid"
      aria-label="Spreadsheet"
      aria-rowcount={sheet.rowCount}
      aria-colcount={sheet.columnCount}
      aria-activedescendant={isActiveCellRendered ? `cell-${currentAddress}` : undefined}
      aria-readonly={isReadOnly}
      tabIndex={0}
      onKeyDown={onKeyDown}
      className="relative h-full w-full overflow-hidden focus:outline-none"
    >
      {/* Header corner */}
      <div
        style={{ position: 'absolute', left: 0, top: 0, width: ROW_HEADER_WIDTH, height: COLUMN_HEADER_HEIGHT, zIndex: 40 }}
        className="border-b border-r border-[var(--separator)] bg-background/80 backdrop-blur"
        aria-hidden="true"
      />

      {/* Column letters */}
      <div
        style={bandStyle({ left: ROW_HEADER_WIDTH, top: 0, right: 0, height: COLUMN_HEADER_HEIGHT, zIndex: 30 })}
        className="bg-background/80 backdrop-blur"
      >
        <div role="row" aria-rowindex={0} style={{ position: 'absolute', inset: 0 }}>
          {hasFrozenColumns && columnHeaderCells(0, frozenColumns - 1, 0)}
          <div style={{ position: 'absolute', inset: 0, left: frozenWidth, overflow: 'hidden' }}>
            {columnHeaderCells(
              Math.max(columns.start, frozenColumns),
              columns.end,
              viewport.scrollLeft + frozenWidth,
            )}
          </div>
        </div>
      </div>

      {/* Row numbers */}
      <div
        style={bandStyle({ left: 0, top: COLUMN_HEADER_HEIGHT, bottom: 0, width: ROW_HEADER_WIDTH, zIndex: 30 })}
        className="bg-background/80 backdrop-blur"
      >
        {hasFrozenRows && rowHeaderCells(0, frozenRows - 1, 0)}
        <div style={{ position: 'absolute', inset: 0, top: frozenHeight, overflow: 'hidden' }}>
          {rowHeaderCells(Math.max(rows.start, frozenRows), rows.end, viewport.scrollTop + frozenHeight)}
        </div>
      </div>

      {/* Scrolling body */}
      <div
        ref={scrollRef}
        data-sheet-scroller
        style={{ position: 'absolute', left: ROW_HEADER_WIDTH, top: COLUMN_HEADER_HEIGHT, right: 0, bottom: 0 }}
        className="overflow-auto middle-section-scroll touch-pan-x touch-pan-y"
      >
        <div style={{ width: columnAxis.total, height: rowAxis.total, position: 'relative' }}>
          {renderRows(
            Math.max(rows.start, frozenRows),
            rows.end,
            Math.max(columns.start, frozenColumns),
            columns.end,
            0,
            0,
          )}
        </div>
      </div>

      {/* Frozen row band — scrolls horizontally with the body, pinned vertically */}
      {hasFrozenRows && (
        <div
          style={bandStyle({
            left: ROW_HEADER_WIDTH + frozenWidth,
            top: COLUMN_HEADER_HEIGHT,
            right: 0,
            height: frozenHeight,
            zIndex: 20,
          })}
          className="bg-background"
        >
          {renderRows(
            0,
            frozenRows - 1,
            Math.max(columns.start, frozenColumns),
            columns.end,
            viewport.scrollLeft + frozenWidth,
            0,
          )}
        </div>
      )}

      {/* Frozen column band — scrolls vertically with the body, pinned horizontally */}
      {hasFrozenColumns && (
        <div
          style={bandStyle({
            left: ROW_HEADER_WIDTH,
            top: COLUMN_HEADER_HEIGHT + frozenHeight,
            bottom: 0,
            width: frozenWidth,
            zIndex: 20,
          })}
          className="bg-background"
        >
          {renderRows(
            Math.max(rows.start, frozenRows),
            rows.end,
            0,
            frozenColumns - 1,
            0,
            viewport.scrollTop + frozenHeight,
          )}
        </div>
      )}

      {/* Frozen corner — pinned on both axes */}
      {hasFrozenRows && hasFrozenColumns && (
        <div
          style={bandStyle({
            left: ROW_HEADER_WIDTH,
            top: COLUMN_HEADER_HEIGHT,
            width: frozenWidth,
            height: frozenHeight,
            zIndex: 25,
          })}
          className="bg-background"
        >
          {renderRows(0, frozenRows - 1, 0, frozenColumns - 1, 0, 0)}
        </div>
      )}

      {/* The frozen seam: a slightly stronger line so the pane boundary reads */}
      {hasFrozenRows && (
        <div
          aria-hidden="true"
          style={{ position: 'absolute', left: ROW_HEADER_WIDTH, right: 0, top: COLUMN_HEADER_HEIGHT + frozenHeight, height: 1, zIndex: 35 }}
          className="bg-border"
        />
      )}
      {hasFrozenColumns && (
        <div
          aria-hidden="true"
          style={{ position: 'absolute', top: COLUMN_HEADER_HEIGHT, bottom: 0, left: ROW_HEADER_WIDTH + frozenWidth, width: 1, zIndex: 35 }}
          className="bg-border"
        />
      )}
    </div>
  );
};
