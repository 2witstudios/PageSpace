"use client";

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { cn } from '@/lib/utils';

interface FormulaBarProps {
  selectedCell: { row: number; col: number } | null;
  cellValue: string;
  formula?: string;
  onFormulaChange: (formula: string) => void;
  isReadOnly?: boolean;
}

const FormulaBar: React.FC<FormulaBarProps> = ({
  selectedCell,
  cellValue,
  formula,
  onFormulaChange,
  isReadOnly = false
}) => {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Convert row/col to A1 notation for display
  const getCellReference = useCallback((row: number, col: number): string => {
    const colStr = String.fromCharCode(65 + col);
    return `${colStr}${row + 1}`;
  }, []);

  // Update edit value when cell selection changes
  useEffect(() => {
    if (selectedCell) {
      const displayValue = formula || cellValue;
      setEditValue(displayValue);
      setIsEditing(false);
    }
  }, [selectedCell, cellValue, formula]);

  // Handle input changes
  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setEditValue(e.target.value);
  }, []);

  // Handle input focus - start editing
  const handleInputFocus = useCallback(() => {
    if (!isReadOnly) {
      setIsEditing(true);
    }
  }, [isReadOnly]);

  // Handle input blur - save changes
  const handleInputBlur = useCallback(() => {
    if (isEditing) {
      onFormulaChange(editValue);
      setIsEditing(false);
    }
  }, [isEditing, editValue, onFormulaChange]);

  // Handle keyboard events
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      onFormulaChange(editValue);
      setIsEditing(false);
      inputRef.current?.blur();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      // Reset to original value
      const originalValue = formula || cellValue;
      setEditValue(originalValue);
      setIsEditing(false);
      inputRef.current?.blur();
    }
  }, [editValue, formula, cellValue, onFormulaChange]);

  // Handle cell reference click to focus input
  const handleCellRefClick = useCallback(() => {
    if (!isReadOnly) {
      inputRef.current?.focus();
    }
  }, [isReadOnly]);

  const currentCellRef = selectedCell
    ? getCellReference(selectedCell.row, selectedCell.col)
    : '';

  const displayValue = isEditing ? editValue : (formula || cellValue);
  const isFormula = displayValue.startsWith('=');

  return (
    <div className="sheet-formula-bar">
      {/* Cell reference */}
      <div
        className={cn(
          "flex-shrink-0 w-20 h-full flex items-center justify-center",
          "bg-muted border-r border-border font-medium text-sm",
          "text-muted-foreground cursor-pointer hover:bg-accent/50",
          "transition-colors",
          !isReadOnly && "hover:text-foreground"
        )}
        onClick={handleCellRefClick}
        title={selectedCell ? `Cell ${currentCellRef}` : 'No cell selected'}
      >
        {currentCellRef || '—'}
      </div>

      {/* Function indicator (fx) */}
      <div className="flex-shrink-0 w-8 h-full flex items-center justify-center bg-muted border-r border-border">
        <span className={cn(
          "text-xs font-medium",
          isFormula ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground"
        )}>
          fx
        </span>
      </div>

      {/* Formula input */}
      <div className="flex-1 relative">
        <input
          ref={inputRef}
          type="text"
          className={cn(
            "sheet-formula-input",
            "w-full h-full px-3 py-0 text-sm",
            "bg-background border-0 focus:outline-none",
            "text-foreground placeholder:text-muted-foreground",
            isFormula && "font-mono",
            isReadOnly && "cursor-default"
          )}
          value={displayValue}
          onChange={handleInputChange}
          onFocus={handleInputFocus}
          onBlur={handleInputBlur}
          onKeyDown={handleKeyDown}
          placeholder={selectedCell ? "Enter a value or formula (e.g., =SUM(A1:A5))" : "Select a cell to edit"}
          disabled={isReadOnly || !selectedCell}
          spellCheck={false}
          autoComplete="off"
        />

        {/* Formula indicator overlay */}
        {isFormula && !isEditing && (
          <div className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none">
            <span className="text-xs bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300 px-1.5 py-0.5 rounded-sm font-medium">
              Formula
            </span>
          </div>
        )}
      </div>

      {/* Status indicator */}
      <div className="flex-shrink-0 w-6 h-full flex items-center justify-center bg-muted border-l border-border">
        {isEditing && (
          <div className="w-2 h-2 bg-orange-500 rounded-full animate-pulse" title="Editing" />
        )}
        {isFormula && !isEditing && (
          <div className="w-2 h-2 bg-blue-500 rounded-full" title="Formula" />
        )}
      </div>
    </div>
  );
};

export default FormulaBar;