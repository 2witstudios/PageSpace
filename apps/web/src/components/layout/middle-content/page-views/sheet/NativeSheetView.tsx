"use client";

import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { cn } from '@/lib/utils';

interface NativeSheetViewProps {
  sheetData: SheetData;
  onCellChange: (row: number, col: number, value: string) => void;
  onCellSelect?: (row: number, col: number) => void;
  selectedCell?: { row: number; col: number } | null;
  isReadOnly?: boolean;
}

export interface SheetData {
  type: 'sheet';
  data: string[][];
  metadata: {
    rows: number;
    cols: number;
    headers: boolean;
    frozenRows: number;
  };
  formulas?: { [cellRef: string]: string }; // e.g., "A1": "=SUM(B1:B5)"
  computedValues?: { [cellRef: string]: string | number }; // cached calculated values
  version: number;
}

const NativeSheetView: React.FC<NativeSheetViewProps> = ({
  sheetData,
  onCellChange,
  onCellSelect,
  selectedCell: externalSelectedCell,
  isReadOnly = false
}) => {
  const [internalSelectedCell, setInternalSelectedCell] = useState<{ row: number; col: number } | null>(null);

  // Use external selected cell if provided, otherwise use internal state
  const selectedCell = externalSelectedCell !== undefined ? externalSelectedCell : internalSelectedCell;
  const [editingCell, setEditingCell] = useState<{ row: number; col: number } | null>(null);
  const [editValue, setEditValue] = useState('');
  const [selectedRange, setSelectedRange] = useState<{
    start: { row: number; col: number };
    end: { row: number; col: number };
  } | null>(null);
  const [hasFocus, setHasFocus] = useState(false);

  const gridRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

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

  // Ensure we have enough columns (minimum 15, or data width + 5)
  const columnCount = Math.max(15, sheetData.metadata.cols + 5);
  const rowCount = Math.max(100, sheetData.metadata.rows + 20);

  // Generate column headers
  const columnHeaders = useMemo(() => {
    return Array.from({ length: columnCount }, (_, i) => getColumnLabel(i));
  }, [columnCount, getColumnLabel]);

  // Get cell value
  const getCellValue = useCallback((row: number, col: number): string => {
    if (sheetData.data[row] && sheetData.data[row][col] !== undefined) {
      return sheetData.data[row][col];
    }
    return '';
  }, [sheetData.data]);

  // Check if cell has a formula
  const cellHasFormula = useCallback((row: number, col: number): boolean => {
    const cellRef = `${String.fromCharCode(65 + col)}${row + 1}`;
    return !!(sheetData.formulas && sheetData.formulas[cellRef]);
  }, [sheetData.formulas]);

  // Handle cell click
  const handleCellClick = useCallback((row: number, col: number, event: React.MouseEvent) => {
    if (isReadOnly) return;

    // Handle shift-click for range selection
    if (event.shiftKey && selectedCell) {
      setSelectedRange({
        start: selectedCell,
        end: { row, col }
      });
    } else {
      // Update selection
      if (onCellSelect) {
        onCellSelect(row, col);
      } else {
        setInternalSelectedCell({ row, col });
      }
      setSelectedRange(null);
    }
  }, [isReadOnly, selectedCell, onCellSelect]);

  // Handle cell double-click to edit
  const handleCellDoubleClick = useCallback((row: number, col: number) => {
    if (isReadOnly) return;

    const value = getCellValue(row, col);
    setEditingCell({ row, col });
    setEditValue(value);

    // Focus input after render
    setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
  }, [isReadOnly, getCellValue]);

  // Handle input change
  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setEditValue(e.target.value);
  }, []);

  // Handle input blur or enter to save
  const handleSaveEdit = useCallback(() => {
    if (editingCell) {
      onCellChange(editingCell.row, editingCell.col, editValue);
      setEditingCell(null);
      setEditValue('');
    }
  }, [editingCell, editValue, onCellChange]);

  // Handle input key down
  const handleInputKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    // Stop propagation to prevent sheet-level keyboard handlers
    e.stopPropagation();

    if (e.key === 'Enter') {
      e.preventDefault();
      handleSaveEdit();
      // Move to next cell down
      if (editingCell && editingCell.row < rowCount - 1) {
        const newCell = { row: editingCell.row + 1, col: editingCell.col };
        if (onCellSelect) {
          onCellSelect(newCell.row, newCell.col);
        } else {
          setInternalSelectedCell(newCell);
        }
      }
    } else if (e.key === 'Tab') {
      e.preventDefault();
      handleSaveEdit();
      // Move to next cell right
      if (editingCell && editingCell.col < columnCount - 1) {
        const newCell = { row: editingCell.row, col: editingCell.col + 1 };
        if (onCellSelect) {
          onCellSelect(newCell.row, newCell.col);
        } else {
          setInternalSelectedCell(newCell);
        }
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setEditingCell(null);
      setEditValue('');
    }
  }, [editingCell, handleSaveEdit, rowCount, columnCount, onCellSelect]);

  // Handle keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Only handle keyboard events when sheet has focus
      if (!hasFocus) return;

      // Check if the event target is within our container
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        return;
      }

      if (editingCell) return; // Don't navigate while editing

      if (!selectedCell) return;

      let newRow = selectedCell.row;
      let newCol = selectedCell.col;

      switch (e.key) {
        case 'ArrowUp':
          e.preventDefault();
          newRow = Math.max(0, selectedCell.row - 1);
          break;
        case 'ArrowDown':
          e.preventDefault();
          newRow = Math.min(rowCount - 1, selectedCell.row + 1);
          break;
        case 'ArrowLeft':
          e.preventDefault();
          newCol = Math.max(0, selectedCell.col - 1);
          break;
        case 'ArrowRight':
          e.preventDefault();
          newCol = Math.min(columnCount - 1, selectedCell.col + 1);
          break;
        case 'Enter':
          e.preventDefault();
          handleCellDoubleClick(selectedCell.row, selectedCell.col);
          return;
        default:
          return;
      }

      const newCell = { row: newRow, col: newCol };
      if (onCellSelect) {
        onCellSelect(newCell.row, newCell.col);
      } else {
        setInternalSelectedCell(newCell);
      }
      setSelectedRange(null);
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [selectedCell, editingCell, rowCount, columnCount, handleCellDoubleClick, hasFocus, onCellSelect]);

  // Check if cell is in selected range
  const isCellInRange = useCallback((row: number, col: number): boolean => {
    if (!selectedRange) return false;

    const minRow = Math.min(selectedRange.start.row, selectedRange.end.row);
    const maxRow = Math.max(selectedRange.start.row, selectedRange.end.row);
    const minCol = Math.min(selectedRange.start.col, selectedRange.end.col);
    const maxCol = Math.max(selectedRange.start.col, selectedRange.end.col);

    return row >= minRow && row <= maxRow && col >= minCol && col <= maxCol;
  }, [selectedRange]);

  // Handle focus/blur on the container
  const handleContainerFocus = useCallback(() => {
    setHasFocus(true);
  }, []);

  const handleContainerBlur = useCallback((e: React.FocusEvent) => {
    // Check if focus is moving to something within the container
    if (!containerRef.current?.contains(e.relatedTarget as Node)) {
      setHasFocus(false);
    }
  }, []);

  return (
    <div
      className="sheet-container"
      ref={containerRef}
      tabIndex={0}
      onFocus={handleContainerFocus}
      onBlur={handleContainerBlur}
    >
      <div className="sheet-wrapper" ref={gridRef}>
        <div className="sheet-grid">
          {/* Corner cell */}
          <div className="sheet-corner" />

          {/* Column headers */}
          {columnHeaders.map((label, index) => (
            <div
              key={`col-header-${index}`}
              className={cn(
                "sheet-column-header",
                selectedCell?.col === index && "selected-column"
              )}
            >
              {label}
            </div>
          ))}

          {/* Rows */}
          {Array.from({ length: rowCount }, (_, rowIndex) => (
            <React.Fragment key={`row-${rowIndex}`}>
              {/* Row header */}
              <div
                className={cn(
                  "sheet-row-header",
                  selectedCell?.row === rowIndex && "selected-row"
                )}
              >
                {rowIndex + 1}
              </div>

              {/* Cells */}
              {Array.from({ length: columnCount }, (_, colIndex) => {
                const isSelected = selectedCell?.row === rowIndex && selectedCell?.col === colIndex;
                const isEditing = editingCell?.row === rowIndex && editingCell?.col === colIndex;
                const isInRange = isCellInRange(rowIndex, colIndex);
                const cellValue = getCellValue(rowIndex, colIndex);
                const hasFormula = cellHasFormula(rowIndex, colIndex);

                return (
                  <div
                    key={`cell-${rowIndex}-${colIndex}`}
                    className={cn(
                      "sheet-cell",
                      isSelected && "selected",
                      isInRange && "in-range",
                      isEditing && "editing",
                      hasFormula && "has-formula"
                    )}
                    onClick={(e) => handleCellClick(rowIndex, colIndex, e)}
                    onDoubleClick={() => handleCellDoubleClick(rowIndex, colIndex)}
                  >
                    {isEditing ? (
                      <input
                        ref={inputRef}
                        type="text"
                        className="sheet-cell-input"
                        value={editValue}
                        onChange={handleInputChange}
                        onBlur={handleSaveEdit}
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={handleInputKeyDown}
                      />
                    ) : (
                      <span className={cn(
                        "sheet-cell-content",
                        cellValue.toString().startsWith('#') && "text-red-600 dark:text-red-400 font-medium",
                        hasFormula && "font-mono"
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
      </div>
    </div>
  );
};

export default NativeSheetView;