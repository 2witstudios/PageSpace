"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TreePage } from '@/hooks/usePageTree';
import { useDocument } from '@/hooks/useDocument';
import { useSocket } from '@/hooks/useSocket';
import { useAuth } from '@/hooks/use-auth';
import { PageEventPayload } from '@/lib/socket-utils';
import { toast } from 'sonner';
import {
  SheetData,
  encodeCellAddress,
  evaluateSheet,
  parseSheetContent,
  sanitizeSheetData,
  serializeSheetContent,
} from '@pagespace/lib';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface SheetViewProps {
  page: TreePage;
}

type GridSelection = {
  row: number;
  column: number;
};

const clampSelection = (selection: GridSelection, sheet: SheetData): GridSelection => ({
  row: Math.min(Math.max(selection.row, 0), Math.max(0, sheet.rowCount - 1)),
  column: Math.min(Math.max(selection.column, 0), Math.max(0, sheet.columnCount - 1)),
});

const getColumnLabel = (columnIndex: number) => encodeCellAddress(0, columnIndex).replace(/\d+/g, '');

const SheetView: React.FC<SheetViewProps> = ({ page }) => {
  const initialSheet = useMemo(() => sanitizeSheetData(parseSheetContent(page.content)), [page.content]);
  const [sheet, setSheet] = useState<SheetData>(initialSheet);
  const [selectedCell, setSelectedCell] = useState<GridSelection>({ row: 0, column: 0 });
  const [formulaValue, setFormulaValue] = useState('');
  const [isFormulaFocused, setIsFormulaFocused] = useState(false);
  const [isReadOnly, setIsReadOnly] = useState(false);
  const formulaInputRef = useRef<HTMLInputElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const socket = useSocket();
  const { user } = useAuth();

  const {
    document: documentState,
    initializeAndActivate,
    updateContent,
    updateContentFromServer,
    saveWithDebounce,
    forceSave,
  } = useDocument(page.id, page.content);

  const evaluation = useMemo(() => evaluateSheet(sheet), [sheet]);
  const currentSelection = clampSelection(selectedCell, sheet);
  const currentAddress = encodeCellAddress(currentSelection.row, currentSelection.column);
  const currentCell = evaluation.byAddress[currentAddress];
  const currentError = currentCell?.error;
  const currentDisplay = currentCell?.error ? '#ERROR' : currentCell?.display ?? '';
  const currentRaw = sheet.cells[currentAddress] ?? '';

  const applySheetUpdate = useCallback(
    (updater: (previous: SheetData) => SheetData, shouldPersist = true) => {
      setSheet((previous) => {
        const updated = updater(previous);
        const sanitized = sanitizeSheetData({ ...updated });
        if (shouldPersist) {
          const serialized = serializeSheetContent(sanitized);
          updateContent(serialized);
          saveWithDebounce(serialized);
        }
        return sanitized;
      });
    },
    [saveWithDebounce, updateContent]
  );

  const handleCommitFormula = useCallback(
    (value: string) => {
      if (isReadOnly) {
        toast.error("You don't have permission to edit this sheet");
        return;
      }
      const trimmed = value;
      setFormulaValue(trimmed);
      applySheetUpdate((previous) => {
        const nextCells = { ...previous.cells };
        if (trimmed.trim() === '') {
          delete nextCells[currentAddress];
        } else {
          nextCells[currentAddress] = trimmed;
        }
        return {
          ...previous,
          version: previous.version + 1,
          cells: nextCells,
        };
      });
    },
    [applySheetUpdate, currentAddress, isReadOnly]
  );

  const handleAddRow = useCallback(() => {
    if (isReadOnly) {
      toast.error("You don't have permission to edit this sheet");
      return;
    }
    applySheetUpdate((previous) => ({
      ...previous,
      version: previous.version + 1,
      rowCount: previous.rowCount + 1,
    }));
  }, [applySheetUpdate, isReadOnly]);

  const handleAddColumn = useCallback(() => {
    if (isReadOnly) {
      toast.error("You don't have permission to edit this sheet");
      return;
    }
    applySheetUpdate((previous) => ({
      ...previous,
      version: previous.version + 1,
      columnCount: previous.columnCount + 1,
    }));
  }, [applySheetUpdate, isReadOnly]);

  const handleCellSelect = useCallback(
    (row: number, column: number) => {
      const next = clampSelection({ row, column }, sheet);
      setSelectedCell(next);
      setIsFormulaFocused(false);
      requestAnimationFrame(() => {
        gridRef.current?.focus({ preventScroll: true });
      });
    },
    [sheet]
  );

  const handleGridKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (!selectedCell) return;
      const { key, shiftKey } = event;
      let { row, column } = clampSelection(selectedCell, sheet);

      switch (key) {
        case 'ArrowUp':
          event.preventDefault();
          row = Math.max(0, row - 1);
          break;
        case 'ArrowDown':
          event.preventDefault();
          row = Math.min(sheet.rowCount - 1, row + 1);
          break;
        case 'ArrowLeft':
          event.preventDefault();
          column = Math.max(0, column - 1);
          break;
        case 'ArrowRight':
          event.preventDefault();
          column = Math.min(sheet.columnCount - 1, column + 1);
          break;
        case 'Tab':
          event.preventDefault();
          if (shiftKey) {
            if (column === 0) {
              column = sheet.columnCount - 1;
              row = Math.max(0, row - 1);
            } else {
              column = Math.max(0, column - 1);
            }
          } else {
            column += 1;
            if (column >= sheet.columnCount) {
              column = 0;
              row = Math.min(sheet.rowCount - 1, row + 1);
            }
          }
          break;
        case 'Enter':
          event.preventDefault();
          if (!isReadOnly) {
            formulaInputRef.current?.focus();
            formulaInputRef.current?.select();
          }
          return;
        default:
          return;
      }

      setSelectedCell({ row, column });
    },
    [isReadOnly, selectedCell, sheet]
  );

  const handleFormulaKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        handleCommitFormula(formulaValue);
        event.currentTarget.blur();
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setFormulaValue(currentRaw);
        event.currentTarget.blur();
      }
    },
    [currentRaw, formulaValue, handleCommitFormula]
  );

  // Initialize sheet when page changes
  useEffect(() => {
    initializeAndActivate();
  }, [initializeAndActivate, page.id]);

  useEffect(() => {
    setSheet(sanitizeSheetData(parseSheetContent(page.content)));
  }, [page.content, page.id]);

  useEffect(() => {
    setSelectedCell({ row: 0, column: 0 });
  }, [page.id]);

  // Update sheet when document content updates
  useEffect(() => {
    if (documentState) {
      setSheet(sanitizeSheetData(parseSheetContent(documentState.content)));
    }
  }, [documentState]);

  // Update formula bar when selection or sheet changes
  useEffect(() => {
    const normalized = encodeCellAddress(currentSelection.row, currentSelection.column);
    if (!isFormulaFocused) {
      setFormulaValue(sheet.cells[normalized] ?? '');
    }
  }, [currentSelection.column, currentSelection.row, isFormulaFocused, sheet.cells]);

  // Clamp selection if sheet dimensions shrink
  useEffect(() => {
    setSelectedCell((prev) => ({
      row: Math.min(Math.max(prev.row, 0), Math.max(0, sheet.rowCount - 1)),
      column: Math.min(Math.max(prev.column, 0), Math.max(0, sheet.columnCount - 1)),
    }));
  }, [sheet.columnCount, sheet.rowCount]);

  // Permission check
  useEffect(() => {
    const checkPermissions = async () => {
      if (!user?.id) return;
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
  }, [page.id, user?.id]);

  // Socket updates
  useEffect(() => {
    if (!socket) return;

    const handleContentUpdate = async (eventData: PageEventPayload) => {
      if (eventData.pageId !== page.id) return;
      try {
        const response = await fetch(`/api/pages/${page.id}`);
        if (!response.ok) return;
        const updatedPage = await response.json();
        if (updatedPage.content !== documentState?.content && !documentState?.isDirty) {
          updateContentFromServer(updatedPage.content);
        }
      } catch (error) {
        console.error('Failed to fetch updated sheet content:', error);
      }
    };

    socket.on('page:content-updated', handleContentUpdate);
    return () => {
      socket.off('page:content-updated', handleContentUpdate);
    };
  }, [documentState?.content, documentState?.isDirty, page.id, socket, updateContentFromServer]);

  // Save on unmount if dirty
  useEffect(() => {
    return () => {
      if (documentState?.isDirty) {
        forceSave().catch(console.error);
      }
    };
  }, [documentState?.isDirty, forceSave]);

  // Save on window blur
  useEffect(() => {
    if (typeof window === 'undefined' || !window.addEventListener) return;
    const handleBlur = () => {
      if (documentState?.isDirty) {
        forceSave().catch(console.error);
      }
    };
    window.addEventListener('blur', handleBlur);
    return () => {
      window.removeEventListener('blur', handleBlur);
    };
  }, [documentState?.isDirty, forceSave]);

  // Ctrl/Cmd + S shortcut
  useEffect(() => {
    if (typeof document === 'undefined' || !document.addEventListener) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 's') {
        event.preventDefault();
        forceSave().catch(console.error);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [forceSave]);

  return (
    <div className="flex h-full flex-col">
      <div className="border-b bg-muted/40">
        <div className="grid grid-cols-[80px_1fr_auto] items-center gap-2 px-4 pt-3 pb-1">
          <span className="text-xs font-medium uppercase text-muted-foreground">Cell</span>
          <div className="font-semibold">{currentAddress}</div>
          <div className="text-xs text-muted-foreground">Value: {currentDisplay || '—'}</div>
        </div>
        <div className="grid grid-cols-[80px_1fr_auto] items-center gap-2 px-4 pb-3">
          <span className="text-xs font-medium uppercase text-muted-foreground">Formula</span>
          <input
            ref={formulaInputRef}
            value={formulaValue}
            onFocus={() => setIsFormulaFocused(true)}
            onBlur={(event) => {
              setIsFormulaFocused(false);
              if (event.target.value !== currentRaw) {
                handleCommitFormula(event.target.value);
              }
            }}
            onChange={(event) => setFormulaValue(event.target.value)}
            onKeyDown={handleFormulaKeyDown}
            disabled={isReadOnly}
            className={cn(
              'w-full rounded border border-input bg-background px-2 py-1 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20',
              isReadOnly && 'cursor-not-allowed opacity-75'
            )}
            placeholder="Enter a value or formula (e.g. =SUM(A1:A5))"
          />
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={handleAddColumn} disabled={isReadOnly}>
              + Column
            </Button>
            <Button variant="outline" size="sm" onClick={handleAddRow} disabled={isReadOnly}>
              + Row
            </Button>
          </div>
        </div>
        {currentError && (
          <div className="px-4 pb-3 text-xs text-destructive">Error: {currentError}</div>
        )}
      </div>
      <div
        ref={gridRef}
        tabIndex={0}
        onKeyDown={handleGridKeyDown}
        className="flex-1 overflow-auto focus:outline-none"
      >
        <table className="min-w-max border-collapse text-sm">
          <thead>
            <tr>
              <th className="sticky left-0 top-0 z-20 h-8 w-14 border border-border bg-muted text-left text-xs font-semibold text-muted-foreground"></th>
              {Array.from({ length: sheet.columnCount }).map((_, columnIndex) => (
                <th
                  key={`column-${columnIndex}`}
                  className="sticky top-0 z-10 h-8 min-w-[120px] border border-border bg-muted px-3 text-left text-xs font-semibold text-muted-foreground"
                >
                  {getColumnLabel(columnIndex)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: sheet.rowCount }).map((_, rowIndex) => (
              <tr key={`row-${rowIndex}`}>
                <th className="sticky left-0 z-10 h-10 border border-border bg-muted px-2 text-left text-xs font-semibold text-muted-foreground">
                  {rowIndex + 1}
                </th>
                {Array.from({ length: sheet.columnCount }).map((_, columnIndex) => {
                  const cellAddress = encodeCellAddress(rowIndex, columnIndex);
                  const isSelected = currentSelection.row === rowIndex && currentSelection.column === columnIndex;
                  const cellError = evaluation.errors[rowIndex]?.[columnIndex];
                  const displayValue = evaluation.display[rowIndex]?.[columnIndex] ?? '';
                  return (
                    <td
                      key={cellAddress}
                      className={cn(
                        'h-10 min-w-[120px] cursor-pointer border border-border bg-background px-3 align-middle',
                        'transition-colors hover:bg-muted/40',
                        isSelected && 'bg-primary/10 outline outline-2 outline-offset-[-2px] outline-primary',
                        cellError && 'bg-destructive/10 text-destructive'
                      )}
                      onClick={() => handleCellSelect(rowIndex, columnIndex)}
                      onDoubleClick={() => {
                        if (!isReadOnly) {
                          formulaInputRef.current?.focus();
                          formulaInputRef.current?.select();
                        }
                      }}
                    >
                      <span className="block w-full truncate">
                        {displayValue}
                      </span>
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
