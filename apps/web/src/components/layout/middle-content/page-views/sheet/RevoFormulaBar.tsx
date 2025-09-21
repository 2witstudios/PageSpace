"use client";

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Check, X, Calculator } from 'lucide-react';
import { SheetDataAdapter } from './SheetDataAdapter';

interface RevoFormulaBarProps {
  selectedCell: string | null;
  adapter: SheetDataAdapter;
  onFormulaChange: (formula: string) => void;
  isReadOnly?: boolean;
  className?: string;
}

const RevoFormulaBar: React.FC<RevoFormulaBarProps> = ({
  selectedCell,
  adapter,
  onFormulaChange,
  isReadOnly = false,
  className
}) => {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const [displayValue, setDisplayValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Update display value when selected cell changes
  useEffect(() => {
    if (selectedCell) {
      const formula = adapter.getCellFormula(selectedCell);
      const value = adapter.getCellValue(selectedCell);

      if (formula) {
        setDisplayValue(formula);
      } else {
        setDisplayValue(String(value || ''));
      }
    } else {
      setDisplayValue('');
    }

    // Exit editing mode when cell changes
    setIsEditing(false);
  }, [selectedCell, adapter]);

  // Start editing
  const handleStartEdit = useCallback(() => {
    if (isReadOnly || !selectedCell) return;

    setIsEditing(true);
    setEditValue(displayValue);

    // Focus input after state update
    setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
  }, [isReadOnly, selectedCell, displayValue]);

  // Cancel editing
  const handleCancelEdit = useCallback(() => {
    setIsEditing(false);
    setEditValue('');
  }, []);

  // Apply edit
  const handleApplyEdit = useCallback(() => {
    if (!selectedCell || !isEditing) return;

    onFormulaChange(editValue);
    setIsEditing(false);
    setEditValue('');
  }, [selectedCell, isEditing, editValue, onFormulaChange]);

  // Handle input changes
  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setEditValue(e.target.value);
  }, []);

  // Handle key events
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation(); // Prevent sheet navigation

    if (e.key === 'Enter') {
      e.preventDefault();
      handleApplyEdit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      handleCancelEdit();
    }
  }, [handleApplyEdit, handleCancelEdit]);

  // Handle input blur
  const handleBlur = useCallback(() => {
    if (isEditing) {
      handleApplyEdit();
    }
  }, [isEditing, handleApplyEdit]);

  // Get cell information
  const cellInfo = selectedCell ? {
    ref: selectedCell,
    value: adapter.getCellValue(selectedCell),
    formula: adapter.getCellFormula(selectedCell),
    type: adapter.getCellType(selectedCell),
    isFormula: adapter.isFormula(selectedCell)
  } : null;

  return (
    <div className={cn(
      'flex items-center gap-2 p-2 border-b bg-muted/30',
      'min-h-[48px]',
      className
    )}>
      {/* Cell reference display */}
      <div className="flex items-center gap-2 min-w-0">
        <div className="flex items-center gap-1 px-2 py-1 bg-background border rounded text-sm font-mono min-w-[60px] justify-center">
          {selectedCell || 'A1'}
        </div>

        {/* Cell type indicator */}
        {cellInfo && (
          <div className="flex items-center gap-1">
            {cellInfo.isFormula ? (
              <Calculator className="w-4 h-4 text-blue-600 dark:text-blue-400" />
            ) : cellInfo.type === 'number' ? (
              <Calculator className="w-4 h-4 text-green-600 dark:text-green-400" />
            ) : null}
          </div>
        )}
      </div>

      {/* Formula input area */}
      <div className="flex-1 flex items-center gap-2">
        {isEditing ? (
          <>
            {/* Editing controls */}
            <Button
              size="sm"
              variant="ghost"
              onClick={handleApplyEdit}
              className="h-8 w-8 p-0 text-green-600 hover:text-green-700 hover:bg-green-50 dark:hover:bg-green-950"
              title="Apply changes (Enter)"
            >
              <Check className="w-4 h-4" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={handleCancelEdit}
              className="h-8 w-8 p-0 text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950"
              title="Cancel changes (Escape)"
            >
              <X className="w-4 h-4" />
            </Button>

            {/* Input field */}
            <Input
              ref={inputRef}
              value={editValue}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              onBlur={handleBlur}
              className={cn(
                'flex-1 font-mono text-sm border-primary focus:ring-primary',
                editValue.startsWith('=') && 'text-blue-600 dark:text-blue-400'
              )}
              placeholder="Enter value or formula (=SUM(A1:A5))"
            />
          </>
        ) : (
          /* Display mode */
          <div
            className={cn(
              'flex-1 px-3 py-2 text-sm bg-background border rounded cursor-text',
              'min-h-[36px] flex items-center',
              'hover:bg-muted/50 transition-colors',
              !isReadOnly && 'focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary',
              displayValue.startsWith('=') && 'font-mono text-blue-600 dark:text-blue-400',
              isReadOnly && 'cursor-default opacity-75'
            )}
            onClick={handleStartEdit}
            onFocus={handleStartEdit}
            tabIndex={isReadOnly ? -1 : 0}
            title={cellInfo?.isFormula ? `Formula: ${cellInfo.formula}` : undefined}
          >
            {displayValue || (
              <span className="text-muted-foreground italic">
                {isReadOnly ? 'No data' : 'Click to edit or press F2'}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Cell value preview (when editing formula) */}
      {isEditing && editValue.startsWith('=') && cellInfo && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span>Result:</span>
          <span className="px-2 py-1 bg-background border rounded font-mono">
            {cellInfo.value || 'N/A'}
          </span>
        </div>
      )}

      {/* Read-only indicator */}
      {isReadOnly && (
        <div className="text-xs text-muted-foreground bg-muted px-2 py-1 rounded">
          Read Only
        </div>
      )}
    </div>
  );
};

export default RevoFormulaBar;