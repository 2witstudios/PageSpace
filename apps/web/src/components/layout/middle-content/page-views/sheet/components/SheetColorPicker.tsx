"use client";

import React, { useState } from 'react';
import { Check, X } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { NEUTRALS, PALETTE, normalizeHex, readableTextColor, swatchRow } from '../core/palette';

interface SheetColorPickerProps {
  /** The colour currently applied, if any. */
  value: string | undefined;
  onChange: (color: string | undefined) => void;
  /** Rendered in the trigger; the current colour is shown as a bar beneath it. */
  icon: React.ReactNode;
  label: string;
  disabled?: boolean;
  /** Return focus to the grid when the popover closes. */
  onRefocusGrid?: () => void;
}

const Swatch: React.FC<{ color: string; isActive: boolean; onSelect: () => void; label: string }> = ({
  color,
  isActive,
  onSelect,
  label,
}) => (
  <button
    type="button"
    aria-label={label}
    aria-pressed={isActive}
    // Keeping the grid focused matters more here than anywhere: the selection
    // the colour applies to lives in the grid, and a blur would drop it.
    onMouseDown={(event) => event.preventDefault()}
    onClick={onSelect}
    style={{ backgroundColor: color }}
    className={cn(
      'flex h-5 w-5 items-center justify-center rounded border-2 transition-transform hover:scale-110',
      isActive ? 'border-primary' : 'border-transparent',
    )}
  >
    {isActive && <Check size={12} strokeWidth={3} style={{ color: readableTextColor(color) }} />}
  </button>
);

/**
 * The swatch popover for text and fill colour.
 *
 * The hues are the product's own (see `core/palette`), in three strengths, so a
 * dashboard built here uses the same vocabulary as a task board rather than
 * Excel's. A hex field underneath covers everything else.
 */
export const SheetColorPicker: React.FC<SheetColorPickerProps> = ({
  value,
  onChange,
  icon,
  label,
  disabled,
  onRefocusGrid,
}) => {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState('');
  const [customError, setCustomError] = useState(false);

  const pick = (color: string | undefined) => {
    onChange(color);
    setOpen(false);
  };

  const submitCustom = () => {
    const normalized = normalizeHex(custom);
    if (!normalized) {
      setCustomError(true);
      return;
    }
    setCustomError(false);
    setCustom('');
    pick(normalized);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label}
          disabled={disabled}
          onMouseDown={(event) => event.preventDefault()}
          className="flex flex-col items-center gap-0.5 rounded-md p-2 transition-colors hover:bg-muted disabled:opacity-50"
        >
          {icon}
          <span
            aria-hidden="true"
            className="h-[3px] w-4 rounded-full border border-[var(--separator)]"
            style={{ backgroundColor: value ?? 'transparent' }}
          />
        </button>
      </PopoverTrigger>
      {/*
        Radix restores focus to the trigger when the popover closes, which parks
        the caret on a toolbar button — arrow keys then do nothing, because the
        spreadsheet's key handler lives on the grid. Preventing the default and
        focusing the grid keeps the selection navigable straight after picking a
        colour. `preventDefault` here does not make the popover modal; it only
        overrides where focus lands on close.
      */}
      <PopoverContent
        className="w-auto p-3"
        align="start"
        onCloseAutoFocus={(event) => {
          if (!onRefocusGrid) return;
          event.preventDefault();
          onRefocusGrid();
        }}
      >
        <div className="flex flex-col gap-3">
          <button
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => pick(undefined)}
            className="flex items-center gap-2 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted"
          >
            <X size={14} />
            Reset to default
          </button>

          {(['tint', 'mid', 'deep'] as const).map((strength) => (
            <div key={strength} className="flex gap-1.5">
              {swatchRow(strength).map((color, index) => (
                <Swatch
                  key={color}
                  color={color}
                  isActive={value === color}
                  onSelect={() => pick(color)}
                  label={`${PALETTE[index].name} ${strength}`}
                />
              ))}
            </div>
          ))}

          <div className="flex gap-1.5 border-t border-[var(--separator)] pt-3">
            {NEUTRALS.map((color) => (
              <Swatch
                key={color}
                color={color}
                isActive={value === color}
                onSelect={() => pick(color)}
                label={`Neutral ${color}`}
              />
            ))}
          </div>

          <div className="flex items-center gap-2">
            <Input
              value={custom}
              onChange={(event) => {
                setCustom(event.target.value);
                setCustomError(false);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  submitCustom();
                }
              }}
              placeholder="#3b82f6"
              aria-label="Custom colour hex"
              aria-invalid={customError}
              className={cn('h-8 font-mono text-xs', customError && 'border-destructive')}
            />
            <button
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={submitCustom}
              className="rounded-md px-2 py-1 text-xs transition-colors hover:bg-muted"
            >
              Apply
            </button>
          </div>
          {customError && (
            <p role="alert" className="text-xs text-destructive">
              Enter a hex colour such as #3b82f6.
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
};
