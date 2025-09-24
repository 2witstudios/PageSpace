"use client";

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

interface FloatingCellEditorProps {
  value: string;
  cellRect: DOMRect | null;
  isVisible: boolean;
  onCommit: (value: string) => void;
  onCancel: () => void;
  onValueChange: (value: string) => void;
  isReadOnly?: boolean;
  initialKey?: string;
}

export const FloatingCellEditor: React.FC<FloatingCellEditorProps> = ({
  value,
  cellRect,
  isVisible,
  onCommit,
  onCancel,
  onValueChange,
  isReadOnly = false,
  initialKey,
}) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [mounted, setMounted] = useState(false);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      event.stopPropagation(); // Prevent grid navigation

      switch (event.key) {
        case 'Enter':
          if (!event.shiftKey) {
            event.preventDefault();
            onCommit(value);
          }
          break;
        case 'Escape':
          event.preventDefault();
          onCancel();
          break;
        case 'Tab':
          event.preventDefault();
          onCommit(value);
          // Let the grid handle tab navigation after commit
          break;
        case 'ArrowUp':
        case 'ArrowDown':
          // Allow navigation to commit and move
          if (!event.shiftKey) {
            event.preventDefault();
            onCommit(value);
          }
          break;
      }
    },
    [value, onCommit, onCancel]
  );

  const handleBlur = useCallback(
    (event: React.FocusEvent<HTMLInputElement>) => {
      // Only commit if we're not cancelling or if the blur is from outside the component
      const relatedTarget = event.relatedTarget as HTMLElement;
      if (!relatedTarget || !relatedTarget.closest('[data-floating-editor]')) {
        onCommit(value);
      }
    },
    [value, onCommit]
  );

  // Handle initial key injection
  useEffect(() => {
    if (isVisible && initialKey && inputRef.current && !mounted) {
      setMounted(true);
      // Clear the current value and insert the initial key
      onValueChange(initialKey);
      // Position cursor at end
      requestAnimationFrame(() => {
        if (inputRef.current) {
          inputRef.current.focus();
          inputRef.current.setSelectionRange(initialKey.length, initialKey.length);
        }
      });
    } else if (isVisible && !initialKey && inputRef.current && !mounted) {
      setMounted(true);
      // Just focus and select all for normal editing
      requestAnimationFrame(() => {
        if (inputRef.current) {
          inputRef.current.focus();
          inputRef.current.select();
        }
      });
    }
  }, [isVisible, initialKey, mounted, onValueChange]);

  // Reset mounted state when visibility changes
  useEffect(() => {
    if (!isVisible) {
      setMounted(false);
    }
  }, [isVisible]);

  // Focus management when becoming visible
  useEffect(() => {
    if (isVisible && inputRef.current && mounted) {
      inputRef.current.focus();
    }
  }, [isVisible, mounted]);

  if (!isVisible || !cellRect || isReadOnly) {
    return null;
  }

  const style: React.CSSProperties = {
    position: 'fixed',
    left: cellRect.left,
    top: cellRect.top,
    width: Math.max(cellRect.width, 120), // Minimum width for comfortable editing
    height: cellRect.height,
    zIndex: 1000,
    pointerEvents: 'auto',
  };

  return (
    <div
      data-floating-editor
      style={style}
      className="pointer-events-none"
    >
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={handleBlur}
        className={cn(
          'h-full w-full rounded-none border-2 border-primary bg-background px-3 py-2 text-sm',
          'focus:outline-none focus:ring-0',
          'pointer-events-auto',
          'font-mono' // Use monospace for formulas
        )}
        style={{
          fontSize: '14px',
          lineHeight: '1.2',
        }}
        autoComplete="off"
        spellCheck={false}
        aria-label="Edit cell value"
        aria-describedby="cell-editor-instructions"
      />
      <div id="cell-editor-instructions" className="sr-only">
        Press Enter to confirm, Escape to cancel, or Tab to move to next cell
      </div>
    </div>
  );
};