"use client";

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { useSuggestion } from '@/hooks/useSuggestion';
import { useSuggestionContext } from '@/components/providers/SuggestionProvider';
import { MentionPickerPortal } from '@/components/mentions/MentionPickerPortal';
import { useMobileKeyboard } from '@/hooks/useMobileKeyboard';
import { computeEditorPosition, isMobileWidth } from './core/layout';
import { sheetTriggerPattern } from './core/constants';

interface FloatingCellEditorProps {
  value: string;
  cellRect: DOMRect | null;
  isVisible: boolean;
  onCommit: (value: string) => void;
  onCancel: () => void;
  onValueChange: (value: string) => void;
  isReadOnly?: boolean;
  initialKey?: string;
  driveId?: string;
  containerWidth?: number;
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
  driveId,
  containerWidth,
}) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [mounted, setMounted] = useState(false);
  const suggestionContext = useSuggestionContext();
  const { height: keyboardHeight } = useMobileKeyboard();
  // Track IME composition state to prevent accidental commits during predictive text
  const [isComposing, setIsComposing] = useState(false);

  // Measure the viewport into state so positioning never reads `window` during render.
  const [viewport, setViewport] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const measure = () =>
      setViewport({
        width: window.innerWidth,
        height: window.visualViewport?.height ?? window.innerHeight,
      });
    measure();
    window.addEventListener('resize', measure);
    window.visualViewport?.addEventListener('resize', measure);
    return () => {
      window.removeEventListener('resize', measure);
      window.visualViewport?.removeEventListener('resize', measure);
    };
  }, []);

  // Add mention support
  const suggestion = useSuggestion({
    inputRef: inputRef as React.RefObject<HTMLTextAreaElement | HTMLInputElement>,
    onValueChange,
    trigger: '@',
    allowedTypes: ['page'],
    driveId,
    mentionFormat: 'markdown-typed',
    variant: 'chat',
    popupPlacement: 'bottom',
    appendSpace: false,
    triggerPattern: sheetTriggerPattern,
  });

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      // Handle mention suggestions first
      suggestion.handleKeyDown(event);
      if (event.defaultPrevented || suggestionContext.isOpen) {
        return;
      }

      event.stopPropagation(); // Prevent grid navigation

      switch (event.key) {
        case 'Enter':
          // Don't commit during IME composition (predictive text, etc.)
          if (isComposing || event.nativeEvent.isComposing) {
            return;
          }
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
          // Allow navigation to commit and move (only if suggestions aren't open)
          if (!event.shiftKey) {
            event.preventDefault();
            onCommit(value);
          }
          break;
      }
    },
    [value, onCommit, onCancel, suggestion, suggestionContext.isOpen, isComposing]
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

  // Responsive sizing for mobile — use container width when available, fall back
  // to the measured viewport width (both injected into the pure layout core).
  const isMobile = isMobileWidth(containerWidth, viewport.width);
  const position = computeEditorPosition(cellRect, keyboardHeight, viewport, isMobile);

  const style: React.CSSProperties = {
    position: 'fixed',
    left: position.left,
    top: position.top,
    width: position.width,
    height: position.height,
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
        onChange={(e) => suggestion.handleValueChange(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={handleBlur}
        onCompositionStart={() => setIsComposing(true)}
        onCompositionEnd={() => setIsComposing(false)}
        className={cn(
          'h-full w-full rounded-none border-2 border-primary bg-background px-2 py-1.5 text-sm',
          'sm:px-3 sm:py-2',
          'focus:outline-none focus:ring-0',
          'pointer-events-auto',
          'font-mono', // Use monospace for formulas
          // Mobile optimizations
          'touch-manipulation'
        )}
        style={{
          fontSize: isMobile ? '16px' : '14px', // 16px prevents iOS zoom on focus
          lineHeight: '1.2',
        }}
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="done"
        aria-label="Edit cell value"
        aria-describedby="cell-editor-instructions"
      />
      <div id="cell-editor-instructions" className="sr-only">
        Press Enter to confirm, Escape to cancel, or Tab to move to next cell
      </div>

      <MentionPickerPortal
        isOpen={suggestionContext.isOpen}
        position={suggestionContext.position}
        driveId={driveId}
        allowedTypes={['page']}
        initialQuery={suggestion.query}
        onSelect={suggestion.actions.selectSuggestion}
        onClose={suggestion.actions.close}
      />
    </div>
  );
};