import React from 'react';
import { Rows3 } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import type { SelectionState } from '../core/selection';
import type { SelectionStats } from '../core/stats';
import type { GridDensity } from '../core/grid-metrics';

const DENSITY_LABELS: Record<GridDensity, string> = {
  compact: 'Compact',
  normal: 'Normal',
  relaxed: 'Relaxed',
};

interface SheetStatusBarProps {
  selectionAddress: string;
  selection: SelectionState;
  stats: SelectionStats;
  density: GridDensity;
  onDensityChange: (density: GridDensity) => void;
}

/** The footer status bar: selection address, range dimensions, and sum/avg/count. */
export const SheetStatusBar: React.FC<SheetStatusBarProps> = ({
  selectionAddress,
  selection,
  stats,
  density,
  onDensityChange,
}) => (
  <div className="@container flex items-center justify-between border-t border-[var(--separator)] bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground sm:px-4">
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
          <span className="hidden @[420px]:inline">
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
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`Row density: ${DENSITY_LABELS[density]}`}
            title="Row density"
            className="flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors hover:bg-muted"
          >
            <Rows3 size={14} />
            <span className="hidden @[520px]:inline">{DENSITY_LABELS[density]}</span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel>Row density</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {(Object.keys(DENSITY_LABELS) as GridDensity[]).map((option) => (
            <DropdownMenuItem
              key={option}
              onSelect={() => onDensityChange(option)}
              className={cn(density === option && 'bg-primary-soft')}
            >
              {DENSITY_LABELS[option]}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  </div>
);
