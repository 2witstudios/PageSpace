"use client";

import React, { useRef, useState, useCallback } from 'react';
import { SheetData, toA1Notation, parseA1Notation } from '@/lib/sheet-utils';
import { cn } from '@/lib/utils';

interface SimpleGridViewProps {
  sheetData: SheetData;
  onCellChange: (cellRef: string, value: string | number, isFormula?: boolean) => void;
  onCellSelect?: (cellRef: string) => void;
  selectedCell?: string | null;
  isReadOnly?: boolean;
  className?: string;
}

const SimpleGridView: React.FC<SimpleGridViewProps> = ({
  sheetData,
  onCellChange,
  onCellSelect,
  selectedCell,
  isReadOnly = false,
  className
}) => {
  const [editingCell, setEditingCell] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Grid dimensions
  const ROWS = 100;
  const COLS = 26;

  // Generate column headers (A, B, C, ..., Z, AA, AB, etc.)
  const getColumnLabel = useCallback((index: number): string => {
    let label = '';
    let i = index;
    while (i >= 0) {
      label = String.fromCharCode(65 + (i % 26)) + label;
      i = Math.floor(i / 26) - 1;
    }
    return label;
  }, []);

  // Get cell value
  const getCellValue = useCallback((cellRef: string): string => {
    const cell = sheetData.cells[cellRef];
    return cell ? String(cell.value || '') : '';
  }, [sheetData.cells]);

  // Check if cell has a formula
  const cellHasFormula = useCallback((cellRef: string): boolean => {
    return !!sheetData.cells[cellRef]?.formula;
  }, [sheetData.cells]);

  // Handle cell click
  const handleCellClick = useCallback((cellRef: string) => {
    if (isReadOnly) return;

    onCellSelect?.(cellRef);
  }, [isReadOnly, onCellSelect]);

  // Handle cell double-click to edit
  const handleCellDoubleClick = useCallback((cellRef: string) => {
    if (isReadOnly) return;

    const cell = sheetData.cells[cellRef];
    const value = cell?.formula || getCellValue(cellRef);

    setEditingCell(cellRef);
    setEditValue(value);

    // Focus input after render
    setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
  }, [isReadOnly, getCellValue, sheetData.cells]);

  // Handle input change
  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setEditValue(e.target.value);
  }, []);

  // Handle save edit
  const handleSaveEdit = useCallback(() => {
    if (editingCell) {
      const isFormula = editValue.startsWith('=');
      onCellChange(editingCell, editValue, isFormula);
      setEditingCell(null);
      setEditValue('');
    }
  }, [editingCell, editValue, onCellChange]);

  // Handle input key down
  const handleInputKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();

    if (e.key === 'Enter') {
      e.preventDefault();
      handleSaveEdit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setEditingCell(null);
      setEditValue('');
    }
  }, [handleSaveEdit]);

  return (
    <div className={cn('simple-grid-container', className)}>
      <div className="simple-grid">
        {/* Corner cell */}
        <div className="grid-corner" />

        {/* Column headers */}
        {Array.from({ length: COLS }, (_, colIndex) => (
          <div
            key={`col-header-${colIndex}`}
            className={cn(
              "grid-column-header",
              selectedCell && parseA1Notation(selectedCell).col === colIndex && "selected"
            )}
          >
            {getColumnLabel(colIndex)}
          </div>
        ))}

        {/* Rows */}
        {Array.from({ length: ROWS }, (_, rowIndex) => (
          <React.Fragment key={`row-${rowIndex}`}>
            {/* Row header */}
            <div
              className={cn(
                "grid-row-header",
                selectedCell && parseA1Notation(selectedCell).row === rowIndex && "selected"
              )}
            >
              {rowIndex + 1}
            </div>

            {/* Cells */}
            {Array.from({ length: COLS }, (_, colIndex) => {
              const cellRef = toA1Notation(rowIndex, colIndex);
              const isSelected = selectedCell === cellRef;
              const isEditing = editingCell === cellRef;
              const cellValue = getCellValue(cellRef);
              const hasFormula = cellHasFormula(cellRef);

              return (
                <div
                  key={cellRef}
                  className={cn(
                    "grid-cell",
                    isSelected && "selected",
                    isEditing && "editing",
                    hasFormula && "has-formula"
                  )}
                  onClick={() => handleCellClick(cellRef)}
                  onDoubleClick={() => handleCellDoubleClick(cellRef)}
                >
                  {isEditing ? (
                    <input
                      ref={inputRef}
                      type="text"
                      className="cell-input"
                      value={editValue}
                      onChange={handleInputChange}
                      onBlur={handleSaveEdit}
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={handleInputKeyDown}
                    />
                  ) : (
                    <span className={cn(
                      "cell-content",
                      cellValue.toString().startsWith('#') && "text-red-600 dark:text-red-400 font-medium",
                      hasFormula && "text-blue-600 dark:text-blue-400 font-mono"
                    )}>
                      {cellValue}
                    </span>
                  )}
                </div>
              );
            })}
          </React.Fragment>
        ))}
      </div>

      <style jsx>{`
        .simple-grid-container {
          height: 100%;
          width: 100%;
          overflow: auto;
          border: 1px solid hsl(var(--border));
        }

        .simple-grid {
          display: grid;
          grid-template-columns: 50px repeat(${COLS}, 120px);
          grid-template-rows: 30px repeat(${ROWS}, 30px);
          min-width: fit-content;
          background: hsl(var(--background));
        }

        .grid-corner {
          background: hsl(var(--muted));
          border-right: 1px solid hsl(var(--border));
          border-bottom: 1px solid hsl(var(--border));
          position: sticky;
          top: 0;
          left: 0;
          z-index: 3;
        }

        .grid-column-header {
          background: hsl(var(--muted));
          border-right: 1px solid hsl(var(--border));
          border-bottom: 1px solid hsl(var(--border));
          display: flex;
          align-items: center;
          justify-content: center;
          font-weight: 500;
          font-size: 12px;
          color: hsl(var(--muted-foreground));
          position: sticky;
          top: 0;
          z-index: 2;
          user-select: none;
        }

        .grid-column-header.selected {
          background: hsl(var(--primary) / 0.1);
          color: hsl(var(--primary));
        }

        .grid-row-header {
          background: hsl(var(--muted));
          border-right: 1px solid hsl(var(--border));
          border-bottom: 1px solid hsl(var(--border));
          display: flex;
          align-items: center;
          justify-content: center;
          font-weight: 500;
          font-size: 12px;
          color: hsl(var(--muted-foreground));
          position: sticky;
          left: 0;
          z-index: 1;
          user-select: none;
        }

        .grid-row-header.selected {
          background: hsl(var(--primary) / 0.1);
          color: hsl(var(--primary));
        }

        .grid-cell {
          border-right: 1px solid hsl(var(--border));
          border-bottom: 1px solid hsl(var(--border));
          display: flex;
          align-items: center;
          padding: 0 8px;
          background: hsl(var(--background));
          cursor: cell;
          position: relative;
          overflow: hidden;
        }

        .grid-cell:hover {
          background: hsl(var(--muted) / 0.3);
        }

        .grid-cell.selected {
          outline: 2px solid hsl(var(--primary));
          outline-offset: -1px;
          background: hsl(var(--background));
          z-index: 1;
        }

        .grid-cell.editing {
          padding: 0;
        }

        .grid-cell.has-formula {
          background: hsl(var(--primary) / 0.05);
        }

        .cell-input {
          width: 100%;
          height: 100%;
          border: none;
          outline: none;
          background: hsl(var(--background));
          color: hsl(var(--foreground));
          padding: 0 8px;
          font-size: 14px;
          font-family: inherit;
        }

        .cell-content {
          width: 100%;
          font-size: 14px;
          line-height: 1.2;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
      `}</style>
    </div>
  );
};

export default SimpleGridView;