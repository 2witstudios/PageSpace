"use client";

import { useState, useEffect, useRef, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface HotkeyInputProps {
  initialValue: string;
  onSave: (binding: string) => void;
  onCancel: () => void;
}

export function HotkeyInput({ initialValue, onSave, onCancel }: HotkeyInputProps) {
  const [binding, setBinding] = useState(initialValue);
  const [isCapturing, setIsCapturing] = useState(true);
  const inputRef = useRef<HTMLDivElement>(null);

  const formatKeyEvent = useCallback((e: KeyboardEvent): string => {
    const parts: string[] = [];

    if (e.ctrlKey) parts.push('Ctrl');
    if (e.metaKey) parts.push('Meta');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');

    // Don't include modifier keys as the main key
    const modifierKeys = ['Control', 'Meta', 'Alt', 'Shift'];
    if (!modifierKeys.includes(e.key)) {
      // Capitalize single letter keys
      const key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
      parts.push(key);
    }

    return parts.join('+');
  }, []);

  useEffect(() => {
    if (!isCapturing) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      // Escape to cancel
      if (e.key === 'Escape') {
        onCancel();
        return;
      }

      // Backspace/Delete to clear (disable the hotkey)
      if (e.key === 'Backspace' || e.key === 'Delete') {
        setBinding('');
        setIsCapturing(false);
        return;
      }

      const formatted = formatKeyEvent(e);

      // Only accept if there's a non-modifier key
      const modifierKeys = ['Control', 'Meta', 'Alt', 'Shift'];
      if (!modifierKeys.includes(e.key)) {
        setBinding(formatted);
        setIsCapturing(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [isCapturing, formatKeyEvent, onCancel]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div className="flex items-center gap-2">
      <div
        ref={inputRef}
        tabIndex={0}
        className={cn(
          "px-3 py-1.5 border rounded-md font-mono text-sm min-w-[120px] text-center",
          "focus:outline-none focus:ring-2 focus:ring-ring",
          isCapturing ? "bg-muted animate-pulse" : "bg-background"
        )}
      >
        {isCapturing ? 'Press keys...' : binding || 'Disabled'}
      </div>
      <Button size="sm" onClick={() => onSave(binding)}>
        Save
      </Button>
      <Button size="sm" variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}
