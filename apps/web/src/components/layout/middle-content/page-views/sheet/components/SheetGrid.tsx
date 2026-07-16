import React from 'react';
import { cn } from '@/lib/utils';
import { encodeCellAddress, type SheetData, type SheetEvaluation } from '@pagespace/lib/sheets/sheet';
import { getColumnLabel, isCellInSelection, type GridSelection, type SelectionState } from '../core/selection';

interface SheetGridProps {
  gridRef: React.RefObject<HTMLDivElement | null>;
  sheet: SheetData;
  selection: SelectionState;
  currentSelection: GridSelection;
  currentAddress: string;
  evaluation: SheetEvaluation;
  editingCell: GridSelection | null;
  isReadOnly: boolean;
  isDragging: boolean;
  findAddressSet: Set<string>;
  currentFindAddress: string | null;

  onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void;
  onCellMouseDown: (row: number, column: number, event: React.MouseEvent) => void;
  onCellMouseEnter: (row: number, column: number) => void;
  onCellSelect: (row: number, column: number) => void;
  onCellRightClick: (row: number, column: number, event: React.MouseEvent) => void;
  onCellDoubleClick: (row: number, column: number) => void;
  onCellTouchStart: (row: number, column: number, event: React.TouchEvent) => void;
  onCellTouchMove: (event: React.TouchEvent) => void;
  onCellTouchEnd: (row: number, column: number, event: React.TouchEvent) => void;
}

/** The scrollable spreadsheet grid: column/row headers and the cell table. */
export const SheetGrid: React.FC<SheetGridProps> = ({
  gridRef,
  sheet,
  selection,
  currentSelection,
  currentAddress,
  evaluation,
  editingCell,
  isReadOnly,
  isDragging,
  findAddressSet,
  currentFindAddress,
  onKeyDown,
  onCellMouseDown,
  onCellMouseEnter,
  onCellSelect,
  onCellRightClick,
  onCellDoubleClick,
  onCellTouchStart,
  onCellTouchMove,
  onCellTouchEnd,
}) => (
  <div
    ref={gridRef}
    role="grid"
    aria-label="Spreadsheet"
    aria-rowcount={sheet.rowCount}
    aria-colcount={sheet.columnCount}
    aria-activedescendant={`cell-${currentAddress}`}
    tabIndex={0}
    onKeyDown={onKeyDown}
    className="focus:outline-none touch-pan-x touch-pan-y"
  >
    <table className="min-w-max border-collapse text-sm" role="presentation">
      <thead>
        <tr role="row">
          <th
            role="columnheader"
            className="sticky left-0 top-0 z-20 h-8 w-10 border border-border bg-muted text-left text-xs font-semibold text-muted-foreground sm:w-14"
            aria-label="Row headers"
          ></th>
          {Array.from({ length: sheet.columnCount }).map((_, columnIndex) => (
            <th
              key={`column-${columnIndex}`}
              role="columnheader"
              aria-colindex={columnIndex + 1}
              className="sticky top-0 z-10 h-8 min-w-[80px] border border-border bg-muted px-2 text-left text-xs font-semibold text-muted-foreground sm:min-w-[120px] sm:px-3"
            >
              {getColumnLabel(columnIndex)}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {Array.from({ length: sheet.rowCount }).map((_, rowIndex) => (
          <tr key={`row-${rowIndex}`} role="row">
            <th
              role="rowheader"
              aria-rowindex={rowIndex + 1}
              className="sticky left-0 z-10 h-9 border border-border bg-muted px-1.5 text-left text-xs font-semibold text-muted-foreground sm:h-10 sm:px-2"
            >
              {rowIndex + 1}
            </th>
            {Array.from({ length: sheet.columnCount }).map((_, columnIndex) => {
              const cellAddress = encodeCellAddress(rowIndex, columnIndex);
              const isSelected = isCellInSelection(rowIndex, columnIndex, selection);
              const isPrimaryCell = currentSelection.row === rowIndex && currentSelection.column === columnIndex;
              const cellError = evaluation.errors[rowIndex]?.[columnIndex];
              const displayValue = evaluation.display[rowIndex]?.[columnIndex] ?? '';
              return (
                <td
                  key={cellAddress}
                  id={`cell-${cellAddress}`}
                  role="gridcell"
                  aria-rowindex={rowIndex + 1}
                  aria-colindex={columnIndex + 1}
                  aria-selected={isSelected}
                  aria-readonly={isReadOnly}
                  aria-label={`${cellAddress}: ${displayValue || 'empty'}`}
                  data-cell={cellAddress}
                  tabIndex={isPrimaryCell ? 0 : -1}
                  className={cn(
                    'h-9 min-w-[80px] cursor-pointer border border-border bg-background px-2 align-middle text-sm',
                    'sm:h-10 sm:min-w-[120px] sm:px-3',
                    'transition-colors hover:bg-muted/40 focus:outline-none focus:ring-2 focus:ring-primary focus:ring-inset',
                    // Mobile: larger tap targets with active states
                    'active:bg-muted/60 touch-manipulation',
                    isSelected && 'bg-primary/10',
                    isPrimaryCell && 'outline outline-2 outline-offset-[-2px] outline-primary',
                    cellError && 'bg-destructive/10 text-destructive',
                    editingCell && editingCell.row === rowIndex && editingCell.column === columnIndex && 'opacity-50',
                    isDragging && 'select-none',
                    findAddressSet.has(cellAddress) && 'find-highlight',
                    currentFindAddress === cellAddress && 'find-highlight-current'
                  )}
                  onMouseDown={(e) => onCellMouseDown(rowIndex, columnIndex, e)}
                  onMouseEnter={() => onCellMouseEnter(rowIndex, columnIndex)}
                  onClick={() => onCellSelect(rowIndex, columnIndex)}
                  onContextMenu={(e) => onCellRightClick(rowIndex, columnIndex, e)}
                  onDoubleClick={() => onCellDoubleClick(rowIndex, columnIndex)}
                  // Touch events for mobile
                  onTouchStart={(e) => onCellTouchStart(rowIndex, columnIndex, e)}
                  onTouchMove={onCellTouchMove}
                  onTouchEnd={(e) => onCellTouchEnd(rowIndex, columnIndex, e)}
                >
                  <span className="block w-full truncate">{displayValue}</span>
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);
