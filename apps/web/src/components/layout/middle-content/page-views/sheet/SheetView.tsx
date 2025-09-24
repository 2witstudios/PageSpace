"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TreePage } from '@/hooks/usePageTree';
import { useDocument } from '@/hooks/useDocument';
import { useSocket } from '@/hooks/useSocket';
import { useAuth } from '@/hooks/use-auth';
import { PageEventPayload } from '@/lib/socket-utils';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Parser as FormulaParser } from 'hot-formula-parser';

const MIN_ROWS = 20;
const MIN_COLS = 10;

interface SheetViewProps {
  page: TreePage;
}

type RawGrid = string[][];

interface EvaluatedCell {
  raw: string;
  display: string;
  error?: string;
  isFormula: boolean;
}

function columnIndexToLabel(index: number): string {
  let label = '';
  let current = index;

  do {
    label = String.fromCharCode((current % 26) + 65) + label;
    current = Math.floor(current / 26) - 1;
  } while (current >= 0);

  return label;
}

function normalizeGrid(rows: string[][]): RawGrid {
  const baseRows = rows.length > 0 ? rows : [['']];
  const maxColumns = Math.max(
    MIN_COLS,
    ...baseRows.map((row) => row.length)
  );

  const normalizedRows = baseRows.map((row) => {
    const cells = row.slice(0, maxColumns);
    while (cells.length < maxColumns) {
      cells.push('');
    }
    return cells;
  });

  while (normalizedRows.length < MIN_ROWS) {
    normalizedRows.push(new Array(maxColumns).fill(''));
  }

  return normalizedRows;
}

function parseSheetContent(content: string): RawGrid {
  if (!content || content.trim() === '') {
    return normalizeGrid([['']]);
  }

  const rows: string[][] = [];
  let current = '';
  let row: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < content.length; i++) {
    const char = content[i];

    if (char === '"') {
      if (inQuotes && content[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      row.push(current);
      current = '';
    } else if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && content[i + 1] === '\n') {
        i++;
      }
      row.push(current);
      rows.push(row);
      row = [];
      current = '';
    } else {
      current += char;
    }
  }

  row.push(current);
  rows.push(row);

  return normalizeGrid(rows);
}

function escapeCsvValue(value: string): string {
  if (value.includes('"')) {
    value = value.replace(/"/g, '""');
  }
  if (/[",\n\r]/.test(value)) {
    return `"${value}"`;
  }
  return value;
}

function trimGrid(grid: RawGrid): string[][] {
  let lastRow = -1;
  let lastColumn = -1;

  for (let r = 0; r < grid.length; r++) {
    for (let c = 0; c < grid[r].length; c++) {
      if (grid[r][c].trim() !== '') {
        lastRow = Math.max(lastRow, r);
        lastColumn = Math.max(lastColumn, c);
      }
    }
  }

  if (lastRow === -1 || lastColumn === -1) {
    return [];
  }

  const trimmed: string[][] = [];
  for (let r = 0; r <= lastRow; r++) {
    trimmed.push(grid[r].slice(0, lastColumn + 1));
  }

  return trimmed;
}

function serializeSheetContent(grid: RawGrid): string {
  const trimmed = trimGrid(grid);
  if (trimmed.length === 0) {
    return '';
  }

  return trimmed
    .map((row) => row.map((cell) => escapeCsvValue(cell ?? '')).join(','))
    .join('\n');
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) {
    return value.toString();
  }
  if (Number.isInteger(value)) {
    return value.toString();
  }
  return parseFloat(value.toFixed(6)).toString();
}

function evaluateSheet(grid: RawGrid): EvaluatedCell[][] {
  const cache = new Map<string, { value: number | string; display: string; error?: string }>();
  const evaluating = new Set<string>();

  const safeNumber = (value: number | string): number | string => {
    if (typeof value === 'number') {
      return value;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : value;
  };

  const evaluateCell = (rowIndex: number, columnIndex: number): { value: number | string; display: string; error?: string } => {
    const key = `${rowIndex}:${columnIndex}`;
    if (cache.has(key)) {
      return cache.get(key)!;
    }

    if (rowIndex < 0 || columnIndex < 0 || rowIndex >= grid.length || columnIndex >= grid[rowIndex].length) {
      const result = { value: '', display: '' };
      cache.set(key, result);
      return result;
    }

    const raw = grid[rowIndex][columnIndex] ?? '';
    const trimmed = raw.trim();

    if (trimmed.startsWith('=')) {
      if (evaluating.has(key)) {
        const cycle = { value: '#CYCLE!', display: '#CYCLE!', error: '#CYCLE!' };
        cache.set(key, cycle);
        return cycle;
      }

      evaluating.add(key);
      const parser = new FormulaParser();

      parser.on('callCellValue', (cellCoord, done) => {
        const r = cellCoord.row.index;
        const c = cellCoord.column.index;
        const result = evaluateCell(r, c);
        if (result.error) {
          done(result.error);
          return;
        }
        const value = safeNumber(result.value);
        if (typeof value === 'number') {
          done(value);
        } else if (value === '') {
          done(0);
        } else {
          const numeric = Number(value);
          done(Number.isFinite(numeric) ? numeric : value);
        }
      });

      parser.on('callRangeValue', (start, end, done) => {
        const fragment: (number | string)[][] = [];
        for (let r = start.row.index; r <= end.row.index; r++) {
          const rowValues: (number | string)[] = [];
          for (let c = start.column.index; c <= end.column.index; c++) {
            const result = evaluateCell(r, c);
            if (result.error) {
              rowValues.push(result.error);
            } else {
              const value = safeNumber(result.value);
              if (typeof value === 'number') {
                rowValues.push(value);
              } else if (value === '') {
                rowValues.push(0);
              } else {
                const numeric = Number(value);
                rowValues.push(Number.isFinite(numeric) ? numeric : value);
              }
            }
          }
          fragment.push(rowValues);
        }
        done(fragment);
      });

      let parsed;
      try {
        const expression = trimmed.startsWith('=') ? trimmed.slice(1) : trimmed;
        parsed = parser.parse(expression);
      } catch (error) {
        evaluating.delete(key);
        const message = error instanceof Error ? error.message : '#ERROR';
        const failure = { value: message, display: message, error: message };
        cache.set(key, failure);
        return failure;
      }

      evaluating.delete(key);

      if (parsed.error) {
        const errorLabel = typeof parsed.error === 'string' ? parsed.error : '#ERROR';
        const failure = { value: errorLabel, display: errorLabel, error: errorLabel };
        cache.set(key, failure);
        return failure;
      }

      const resultValue = parsed.result;
      let display: string;
      if (typeof resultValue === 'number') {
        display = formatNumber(resultValue);
      } else if (resultValue === null || typeof resultValue === 'undefined') {
        display = '';
      } else {
        display = String(resultValue);
      }

      const success = { value: resultValue as number | string, display };
      cache.set(key, success);
      return success;
    }

    const numeric = Number(trimmed);
    if (trimmed === '' || Number.isNaN(numeric)) {
      const result = { value: trimmed, display: trimmed };
      cache.set(key, result);
      return result;
    }

    const numericResult = { value: numeric, display: trimmed };
    cache.set(key, numericResult);
    return numericResult;
  };

  return grid.map((row, rowIndex) =>
    row.map((cell, columnIndex) => {
      const evaluation = evaluateCell(rowIndex, columnIndex);
      return {
        raw: cell,
        display: evaluation.display,
        error: evaluation.error,
        isFormula: cell.trim().startsWith('='),
      } satisfies EvaluatedCell;
    })
  );
}

const SheetView = ({ page }: SheetViewProps) => {
  const initialContent = typeof page.content === 'string' ? page.content : '';
  const [rawGrid, setRawGrid] = useState<RawGrid>(() => parseSheetContent(initialContent));
  const [selectedCell, setSelectedCell] = useState<{ row: number; column: number }>({ row: 0, column: 0 });
  const [isReadOnly, setIsReadOnly] = useState(false);
  const serializedRef = useRef<string>(initialContent || '');
  const socket = useSocket();
  const { user } = useAuth();

  const {
    document: documentState,
    initializeAndActivate,
    updateContent,
    updateContentFromServer,
    saveWithDebounce,
    forceSave,
  } = useDocument(page.id, initialContent);

  useEffect(() => {
    initializeAndActivate();
  }, [initializeAndActivate]);

  useEffect(() => {
    if (!user?.id) {
      return;
    }

    const checkPermissions = async () => {
      try {
        const response = await fetch(`/api/pages/${page.id}/permissions/check?userId=${user.id}`);
        if (response.ok) {
          const permissions = await response.json();
          setIsReadOnly(!permissions.canEdit);
          if (!permissions.canEdit) {
            toast.info("You don't have permission to edit this sheet", {
              duration: 4000,
              position: 'bottom-right',
            });
          }
        }
      } catch (error) {
        console.error('Failed to check permissions:', error);
      }
    };

    checkPermissions();
  }, [user?.id, page.id]);

  useEffect(() => {
    if (!socket) {
      return;
    }

    const handleContentUpdate = async (eventData: PageEventPayload) => {
      if (eventData.pageId === page.id) {
        try {
          const response = await fetch(`/api/pages/${page.id}`);
          if (response.ok) {
            const updatedPage = await response.json();
            if (updatedPage.content !== documentState?.content && !documentState?.isDirty) {
              serializedRef.current = updatedPage.content || '';
              updateContentFromServer(updatedPage.content || '');
              setRawGrid(parseSheetContent(updatedPage.content || ''));
            }
          }
        } catch (error) {
          console.error('Failed to fetch updated content:', error);
        }
      }
    };

    socket.on('page:content-updated', handleContentUpdate);

    return () => {
      socket.off('page:content-updated', handleContentUpdate);
    };
  }, [socket, page.id, documentState, updateContentFromServer]);

  useEffect(() => {
    const nextContent = typeof documentState?.content === 'string' ? documentState.content : '';
    if (nextContent !== serializedRef.current) {
      serializedRef.current = nextContent;
      setRawGrid(parseSheetContent(nextContent));
    }
  }, [documentState?.content]);

  useEffect(() => {
    return () => {
      if (documentState?.isDirty) {
        fetch(`/api/pages/${page.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: documentState.content }),
        }).catch((error) => {
          console.error('Failed to save sheet on unmount:', error);
        });
      }
    };
  }, [documentState, page.id]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 's') {
        event.preventDefault();
        forceSave().catch((error) => console.error('Force save failed:', error));
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [forceSave]);

  useEffect(() => {
    const handleBlur = () => {
      if (documentState?.isDirty) {
        forceSave().catch((error) => console.error('Auto-save on blur failed:', error));
      }
    };

    window.addEventListener('blur', handleBlur);
    return () => {
      window.removeEventListener('blur', handleBlur);
    };
  }, [documentState?.isDirty, forceSave]);

  useEffect(() => {
    setSelectedCell((previous) => {
      const clampedRow = Math.min(previous.row, rawGrid.length - 1);
      const clampedColumn = Math.min(previous.column, rawGrid[0]?.length - 1);
      return { row: clampedRow, column: clampedColumn };
    });
  }, [rawGrid]);

  const evaluatedGrid = useMemo(() => evaluateSheet(rawGrid), [rawGrid]);

  const updateGrid = useCallback(
    (updater: (grid: RawGrid) => RawGrid) => {
      setRawGrid((previous) => {
        const updated = normalizeGrid(updater(previous));
        const serialized = serializeSheetContent(updated);
        serializedRef.current = serialized;
        updateContent(serialized);
        saveWithDebounce(serialized);
        return updated;
      });
    },
    [saveWithDebounce, updateContent]
  );

  const handleFormulaChange = useCallback(
    (value: string) => {
      if (isReadOnly) {
        toast.error('This sheet is read-only.');
        return;
      }
      updateGrid((grid) => {
        const next = grid.map((row) => row.slice());
        next[selectedCell.row][selectedCell.column] = value;
        return next;
      });
    },
    [isReadOnly, selectedCell, updateGrid]
  );

  const handleAddRow = () => {
    if (isReadOnly) {
      toast.error('This sheet is read-only.');
      return;
    }
    updateGrid((grid) => [...grid, new Array(grid[0]?.length || MIN_COLS).fill('')]);
  };

  const handleAddColumn = () => {
    if (isReadOnly) {
      toast.error('This sheet is read-only.');
      return;
    }
    updateGrid((grid) => grid.map((row) => [...row, '']));
  };

  const handleClearCell = () => {
    if (isReadOnly) {
      toast.error('This sheet is read-only.');
      return;
    }
    updateGrid((grid) => {
      const next = grid.map((row) => row.slice());
      next[selectedCell.row][selectedCell.column] = '';
      return next;
    });
  };

  const selectedDisplayLabel = `${columnIndexToLabel(selectedCell.column)}${selectedCell.row + 1}`;
  const selectedRawValue = rawGrid[selectedCell.row]?.[selectedCell.column] ?? '';

  return (
    <div className="h-full flex flex-col">
      <div className="border-b px-4 py-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-xl font-semibold">{page.title}</h1>
            <p className="text-sm text-muted-foreground">
              Enter values or formulas (e.g. =SUM(A2:A5)) directly into the active cell.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={handleAddRow} disabled={isReadOnly}>
              Add Row
            </Button>
            <Button size="sm" variant="outline" onClick={handleAddColumn} disabled={isReadOnly}>
              Add Column
            </Button>
            <Button size="sm" variant="outline" onClick={handleClearCell} disabled={isReadOnly}>
              Clear Cell
            </Button>
          </div>
        </div>
      </div>

      <div className="border-b px-4 py-3 flex items-center gap-3 bg-muted/30">
        <span className="text-sm font-medium text-muted-foreground w-16">{selectedDisplayLabel}</span>
        <input
          className="flex-1 rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:ring"
          value={selectedRawValue}
          onChange={(event) => handleFormulaChange(event.target.value)}
          disabled={isReadOnly}
          placeholder="Enter a value or formula"
        />
      </div>

      <div className="flex-1 overflow-auto">
        <table className="min-w-full border-collapse">
          <thead className="sticky top-0 bg-muted/40">
            <tr>
              <th className="sticky left-0 z-20 border border-border bg-muted/60 px-2 py-1 text-left text-xs font-semibold text-muted-foreground">
                &nbsp;
              </th>
              {rawGrid[0]?.map((_, columnIndex) => (
                <th
                  key={`col-${columnIndex}`}
                  className="border border-border px-2 py-1 text-left text-xs font-semibold text-muted-foreground"
                >
                  {columnIndexToLabel(columnIndex)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rawGrid.map((row, rowIndex) => (
              <tr key={`row-${rowIndex}`}>
                <th className="sticky left-0 z-10 border border-border bg-muted/60 px-2 py-1 text-right text-xs font-semibold text-muted-foreground">
                  {rowIndex + 1}
                </th>
                {row.map((_, columnIndex) => {
                  const evaluation = evaluatedGrid[rowIndex]?.[columnIndex];
                  const isActive = selectedCell.row === rowIndex && selectedCell.column === columnIndex;
                  const displayValue = evaluation?.error ? evaluation.error : evaluation?.display ?? '';

                  return (
                    <td key={`cell-${rowIndex}-${columnIndex}`} className="border border-border">
                      <button
                        type="button"
                        onClick={() => setSelectedCell({ row: rowIndex, column: columnIndex })}
                        className={cn(
                          'block w-full min-h-[2.25rem] px-2 text-left text-sm focus:outline-none focus-visible:ring',
                          isActive ? 'bg-primary/10 ring-2 ring-primary/60' : 'bg-background'
                        )}
                      >
                        <span className={cn('block truncate', evaluation?.error ? 'text-destructive font-medium' : undefined)}>
                          {displayValue}
                        </span>
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default SheetView;
