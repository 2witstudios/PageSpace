'use client';

import React, { memo, useMemo } from 'react';
import { usePageNavigation } from '@/hooks/usePageNavigation';
import { Table2, ExternalLink, Sigma, Eraser } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface SheetCellInput {
  address: string;
  value?: string;
}

export interface SheetCellResult {
  address: string;
  type?: 'value' | 'formula' | 'cleared' | string;
}

interface SheetEditRendererProps {
  /** The cell updates that were requested (address + value). */
  inputCells?: SheetCellInput[];
  /** The applied cell results (address + type) from the tool output. */
  resultCells?: SheetCellResult[];
  title?: string;
  pageId?: string;
  driveId?: string;
  cellsUpdated?: number;
  maxHeight?: number;
  className?: string;
}

const TYPE_BADGE: Record<string, { label: string; className: string; icon?: React.ElementType }> = {
  formula: { label: 'formula', className: 'bg-violet-500/10 text-violet-700 dark:text-violet-400', icon: Sigma },
  cleared: { label: 'cleared', className: 'bg-muted text-muted-foreground', icon: Eraser },
  value: { label: 'value', className: 'bg-blue-500/10 text-blue-700 dark:text-blue-400' },
};

/**
 * SheetEditRenderer - Cell-level changes from edit_sheet_cells.
 *
 * Merges the requested cell values (input) with the applied cell types (output)
 * into a compact address → value table.
 */
export const SheetEditRenderer: React.FC<SheetEditRendererProps> = memo(function SheetEditRenderer({
  inputCells,
  resultCells,
  title = 'Sheet',
  pageId,
  driveId,
  cellsUpdated,
  maxHeight = 280,
  className,
}) {
  const { navigateToPage } = usePageNavigation();

  const rows = useMemo(() => {
    const valueByAddress = new Map<string, string>();
    for (const c of inputCells ?? []) {
      valueByAddress.set(c.address.toUpperCase(), c.value ?? '');
    }
    // Prefer the authoritative applied list; fall back to the input list.
    const source: SheetCellResult[] =
      resultCells && resultCells.length > 0
        ? resultCells
        : (inputCells ?? []).map((c) => ({ address: c.address.toUpperCase() }));

    return source.map((c) => {
      const address = c.address.toUpperCase();
      const value = valueByAddress.get(address) ?? '';
      const type = c.type ?? (value.trim() === '' ? 'cleared' : value.trim().startsWith('=') ? 'formula' : 'value');
      return { address, value, type };
    });
  }, [inputCells, resultCells]);

  const count = cellsUpdated ?? rows.length;

  return (
    <div className={cn('rounded-lg border bg-card overflow-hidden my-2 shadow-sm', className)}>
      <button
        type="button"
        onClick={() => pageId && navigateToPage(pageId, driveId)}
        disabled={!pageId}
        className={cn(
          'w-full flex items-center justify-between px-3 py-2 bg-muted/30 border-b text-left',
          'hover:bg-muted/50 transition-colors',
          !pageId && 'cursor-default'
        )}
      >
        <div className="flex items-center gap-2 min-w-0">
          <Table2 className="h-4 w-4 text-muted-foreground shrink-0" />
          <span className="text-sm font-medium truncate" title={title}>
            {title}
          </span>
        </div>
        <span className="flex items-center gap-2 shrink-0">
          <span className="text-xs text-muted-foreground">
            {count} {count === 1 ? 'cell' : 'cells'}
          </span>
          {pageId && <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />}
        </span>
      </button>

      <div className="bg-background overflow-auto divide-y divide-border" style={{ maxHeight: `${maxHeight}px` }}>
        {rows.length === 0 ? (
          <div className="text-sm text-muted-foreground text-center py-4">No cells changed</div>
        ) : (
          rows.map((row, i) => {
            const badge = TYPE_BADGE[row.type] ?? TYPE_BADGE.value;
            const BadgeIcon = badge.icon;
            return (
              <div key={`${row.address}-${i}`} className="flex items-center gap-3 px-3 py-1.5 text-sm">
                <code className="w-14 shrink-0 font-mono text-xs text-muted-foreground">{row.address}</code>
                <span className="flex-1 min-w-0 truncate font-mono text-xs">
                  {row.type === 'cleared' ? <span className="text-muted-foreground italic">empty</span> : row.value}
                </span>
                <span
                  className={cn(
                    'flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded shrink-0',
                    badge.className
                  )}
                >
                  {BadgeIcon && <BadgeIcon className="h-3 w-3" />}
                  {badge.label}
                </span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
});
