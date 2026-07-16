import React from 'react';
import type { SelectionState } from '../core/selection';
import type { SelectionStats } from '../core/stats';

interface SheetStatusBarProps {
  selectionAddress: string;
  selection: SelectionState;
  stats: SelectionStats;
}

/** The footer status bar: selection address, range dimensions, and sum/avg/count. */
export const SheetStatusBar: React.FC<SheetStatusBarProps> = ({ selectionAddress, selection, stats }) => (
  <div className="flex items-center justify-between border-t bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground sm:px-4">
    <div className="flex items-center gap-4">
      <span className="font-medium">{selectionAddress}</span>
      {selection.type === 'range' && (
        <span className="text-muted-foreground/70">
          {Math.abs(selection.range.end.row - selection.range.start.row) + 1} × {Math.abs(selection.range.end.column - selection.range.start.column) + 1} cells
        </span>
      )}
    </div>
    <div className="flex items-center gap-3 sm:gap-4">
      {stats.numericCount > 0 && (
        <>
          <span className="hidden sm:inline">
            <span className="text-muted-foreground/70">Sum: </span>
            <span className="font-medium tabular-nums">{stats.sum?.toLocaleString(undefined, { maximumFractionDigits: 4 })}</span>
          </span>
          <span>
            <span className="text-muted-foreground/70">Avg: </span>
            <span className="font-medium tabular-nums">{stats.average?.toLocaleString(undefined, { maximumFractionDigits: 4 })}</span>
          </span>
        </>
      )}
      <span>
        <span className="text-muted-foreground/70">Count: </span>
        <span className="font-medium tabular-nums">{stats.count}</span>
      </span>
    </div>
  </div>
);
