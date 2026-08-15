"use client";

import { useState, useEffect, useRef, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  eventToBinding,
  formatBindingForDisplay,
  hasModifier,
  isMacPlatform,
} from '@/lib/hotkeys/binding';

interface HotkeyInputProps {
  initialValue: string;
  onSave: (binding: string) => void;
  onCancel: () => void;
}

export function HotkeyInput({ initialValue, onSave, onCancel }: HotkeyInputProps) {
  const [binding, setBinding] = useState(initialValue);
  const [isCapturing, setIsCapturing] = useState(true);
  const [hint, setHint] = useState<string | null>(null);
  const inputRef = useRef<HTMLDivElement>(null);
  const isMac = useMemo(() => isMacPlatform(), []);

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
        setHint(null);
        setIsCapturing(false);
        return;
      }

      // Resolved through the same helper the runtime matcher uses, so what is
      // recorded here is exactly what will be compared against future presses.
      const captured = eventToBinding(e);

      // Modifiers alone aren't a binding — keep waiting for the main key.
      if (!captured) return;

      // A bare key would fire against the global listeners while browsing.
      if (!hasModifier(captured)) {
        setHint('Add a modifier (Ctrl/Cmd/Alt/Shift)');
        return;
      }

      setBinding(captured);
      setHint(null);
      setIsCapturing(false);
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [isCapturing, onCancel]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div className="flex items-center gap-2">
      <div className="flex flex-col items-center gap-1">
        <div
          ref={inputRef}
          tabIndex={0}
          className={cn(
            "px-3 py-1.5 border rounded-md font-mono text-sm min-w-[120px] text-center",
            "focus:outline-none focus:ring-2 focus:ring-ring",
            isCapturing ? "bg-muted animate-pulse" : "bg-background"
          )}
        >
          {isCapturing
            ? 'Press keys...'
            : formatBindingForDisplay(binding, isMac) || 'Disabled'}
        </div>
        {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
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
