"use client";

import React from 'react';
import { cn } from '@/lib/utils';

/**
 * Handlers are grouped into one object with a stable identity so a cell's props
 * are otherwise all primitives. Passing nine separate callbacks would defeat
 * the memo on every render, which is the usual reason a "virtualized" grid
 * still re-renders every visible cell on each keystroke.
 */
export interface SheetCellHandlers {
  onMouseDown: (row: number, column: number, event: React.MouseEvent) => void;
  onMouseEnter: (row: number, column: number) => void;
  onDoubleClick: (row: number, column: number) => void;
  onContextMenu: (row: number, column: number, event: React.MouseEvent) => void;
  onTouchStart: (row: number, column: number, event: React.TouchEvent) => void;
  onTouchMove: (event: React.TouchEvent) => void;
  onTouchEnd: (row: number, column: number, event: React.TouchEvent) => void;
}

export interface SheetCellProps {
  address: string;
  row: number;
  column: number;
  left: number;
  top: number;
  width: number;
  height: number;
  display: string;
  hasError: boolean;
  isSelected: boolean;
  isPrimary: boolean;
  isEditing: boolean;
  isFindMatch: boolean;
  isCurrentFind: boolean;
  /** Numbers right-align and use tabular figures unless the format says otherwise. */
  isNumeric: boolean;
  wraps: boolean;
  isReadOnly: boolean;
  /** Presentation resolved by the evaluator (`cellFormatToStyle`). */
  formatStyle: React.CSSProperties;
  handlers: SheetCellHandlers;
}

const SheetCellComponent: React.FC<SheetCellProps> = ({
  address,
  row,
  column,
  left,
  top,
  width,
  height,
  display,
  hasError,
  isSelected,
  isPrimary,
  isEditing,
  isFindMatch,
  isCurrentFind,
  isNumeric,
  wraps,
  isReadOnly,
  formatStyle,
  handlers,
}) => (
  <div
    id={`cell-${address}`}
    role="gridcell"
    aria-rowindex={row + 1}
    aria-colindex={column + 1}
    aria-selected={isSelected}
    aria-readonly={isReadOnly}
    aria-label={`${address}: ${display || 'empty'}`}
    data-cell={address}
    tabIndex={-1}
    style={{
      position: 'absolute',
      transform: `translate3d(${left}px, ${top}px, 0)`,
      width,
      height,
      ...formatStyle,
    }}
    className={cn(
      // A single hairline per cell, drawn on two sides only. The old surface put
      // a full-strength border on all four sides of every cell, which collapsed
      // into a double-weight grey mesh — the single biggest reason it read as a
      // rendering of a spreadsheet rather than part of the product.
      'box-border border-b border-r border-[var(--separator)]',
      'flex items-center px-2 text-sm leading-tight',
      'cursor-cell select-none touch-manipulation',
      isNumeric && 'justify-end font-mono tabular-nums',
      wraps ? 'whitespace-pre-wrap break-words' : 'overflow-hidden whitespace-nowrap',
      hasError && 'text-destructive',
      isSelected && !isPrimary && 'bg-primary/10',
      isCurrentFind && 'find-highlight-current',
      !isCurrentFind && isFindMatch && 'find-highlight',
      // The active cell is drawn with the system focus ring, inset so it does not
      // nudge the grid, rather than an off-system 2px outline.
      isPrimary && 'ring-2 ring-ring ring-inset z-[1]',
      isEditing && 'opacity-0',
    )}
    onMouseDown={(event) => handlers.onMouseDown(row, column, event)}
    onMouseEnter={() => handlers.onMouseEnter(row, column)}
    onDoubleClick={() => handlers.onDoubleClick(row, column)}
    onContextMenu={(event) => handlers.onContextMenu(row, column, event)}
    onTouchStart={(event) => handlers.onTouchStart(row, column, event)}
    onTouchMove={handlers.onTouchMove}
    onTouchEnd={(event) => handlers.onTouchEnd(row, column, event)}
  >
    {wraps ? display : <span className="block w-full truncate">{display}</span>}
  </div>
);

const styleEqual = (a: React.CSSProperties, b: React.CSSProperties): boolean => {
  if (a === b) return true;
  const keys = Object.keys(a) as Array<keyof React.CSSProperties>;
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => a[key] === b[key]);
};

/**
 * `formatStyle` is rebuilt by the evaluator on every sheet change, so its
 * identity is never stable; comparing it by value is what keeps a keystroke in
 * one cell from re-rendering every other visible cell.
 */
export const SheetCell = React.memo(SheetCellComponent, (previous, next) => {
  const keys = Object.keys(previous) as Array<keyof SheetCellProps>;
  return keys.every((key) =>
    key === 'formatStyle'
      ? styleEqual(previous.formatStyle, next.formatStyle)
      : previous[key] === next[key],
  );
});

SheetCell.displayName = 'SheetCell';
