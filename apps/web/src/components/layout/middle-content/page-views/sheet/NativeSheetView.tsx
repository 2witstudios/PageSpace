"use client";

import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { motion } from 'motion/react';
import { cn } from '@/lib/utils';

interface NativeSheetViewProps {
  sheetData: SheetData;
  onCellChange: (row: number, col: number, value: string) => void;
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
  version: number;
}

const NativeSheetView: React.FC<NativeSheetViewProps> = ({
  sheetData,
  onCellChange,
  isReadOnly = false
}) => {
  const [selectedCell, setSelectedCell] = useState<{ row: number; col: number } | null>(null);
  const [editingCell, setEditingCell] = useState<{ row: number; col: number } | null>(null);
  const [editValue, setEditValue] = useState('');
  const [selectedRange, setSelectedRange] = useState<{
    start: { row: number; col: number };
    end: { row: number; col: number };
  } | null>(null);

  const gridRef = useRef<HTMLDivElement>(null);
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
      setSelectedCell({ row, col });
      setSelectedRange(null);
    }
  }, [isReadOnly, selectedCell]);

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
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSaveEdit();
      // Move to next cell down
      if (editingCell && editingCell.row < rowCount - 1) {
        setSelectedCell({ row: editingCell.row + 1, col: editingCell.col });
      }
    } else if (e.key === 'Tab') {
      e.preventDefault();
      handleSaveEdit();
      // Move to next cell right
      if (editingCell && editingCell.col < columnCount - 1) {
        setSelectedCell({ row: editingCell.row, col: editingCell.col + 1 });
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setEditingCell(null);
      setEditValue('');
    }
  }, [editingCell, handleSaveEdit, rowCount, columnCount]);

  // Handle keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
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

      setSelectedCell({ row: newRow, col: newCol });
      setSelectedRange(null);
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [selectedCell, editingCell, rowCount, columnCount, handleCellDoubleClick]);

  // Check if cell is in selected range
  const isCellInRange = useCallback((row: number, col: number): boolean => {
    if (!selectedRange) return false;

    const minRow = Math.min(selectedRange.start.row, selectedRange.end.row);
    const maxRow = Math.max(selectedRange.start.row, selectedRange.end.row);
    const minCol = Math.min(selectedRange.start.col, selectedRange.end.col);
    const maxCol = Math.max(selectedRange.start.col, selectedRange.end.col);

    return row >= minRow && row <= maxRow && col >= minCol && col <= maxCol;
  }, [selectedRange]);

  return (
    <div className="sheet-container">
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

                return (
                  <div
                    key={`cell-${rowIndex}-${colIndex}`}
                    className={cn(
                      "sheet-cell",
                      isSelected && "selected",
                      isInRange && "in-range",
                      isEditing && "editing"
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
                        onKeyDown={handleInputKeyDown}
                      />
                    ) : (
                      <span className="sheet-cell-content">
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