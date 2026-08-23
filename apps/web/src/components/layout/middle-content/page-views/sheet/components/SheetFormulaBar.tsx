"use client";

import React from 'react';
import { Columns3, FunctionSquare, Rows3 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { MentionPickerPortal } from '@/components/mentions/MentionPickerPortal';
import type { Position } from '@/services/positioningService';
import type { MentionSuggestion } from '@/types/mentions';

interface SheetFormulaBarProps {
  isRange: boolean;
  selectionAddress: string;
  currentDisplay: string;
  currentError?: string;

  isReadOnly: boolean;
  onAddRow: () => void;
  onAddColumn: () => void;

  formulaInputRef: React.RefObject<HTMLInputElement | null>;
  formulaValue: string;
  onFormulaFocus: () => void;
  onFormulaBlur: (event: React.FocusEvent<HTMLInputElement>) => void;
  onFormulaChange: (value: string) => void;
  onFormulaKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void;

  driveId: string;
  mention: {
    isOpen: boolean;
    position: Position | null;
    query: string;
    onSelect: (suggestion: MentionSuggestion) => void;
    onClose: () => void;
  };
}

/**
 * The formula bar: the address chip, the mention-aware formula input, and the
 * structural add buttons.
 *
 * Undo and redo used to live here as two hand-drawn inline SVGs at the lucide
 * default stroke weight, which read heavier than every other icon in the
 * product. They now sit in the toolbar with the rest of the commands, so this
 * row is one line instead of three.
 *
 * Breakpoints are container queries, not `sm:` — the sheet lives in a resizable
 * pane, so what matters is how wide the pane is, not the window.
 */
export const SheetFormulaBar: React.FC<SheetFormulaBarProps> = ({
  isRange,
  selectionAddress,
  currentDisplay,
  currentError,
  isReadOnly,
  onAddRow,
  onAddColumn,
  formulaInputRef,
  formulaValue,
  onFormulaFocus,
  onFormulaBlur,
  onFormulaChange,
  onFormulaKeyDown,
  driveId,
  mention,
}) => (
  <div className="@container px-4 pt-2">
    <div className="flex items-center gap-2">
      {/* The address chip: monospace and fixed-width so the input does not
          shift as the selection moves between A1 and AB100. */}
      <span
        className={cn(
          'shrink-0 rounded-md border border-[var(--separator)] bg-muted/50 px-2 py-1',
          'min-w-[72px] text-center font-mono text-xs tabular-nums text-foreground',
        )}
        aria-label={isRange ? 'Selected range' : 'Selected cell'}
        title={isRange ? 'Selected range' : 'Selected cell'}
      >
        {selectionAddress}
      </span>

      <FunctionSquare size={16} className="hidden shrink-0 text-muted-foreground @[420px]:block" aria-hidden="true" />

      <div className="relative flex-1">
        <input
          ref={formulaInputRef}
          value={formulaValue}
          onFocus={onFormulaFocus}
          onBlur={onFormulaBlur}
          onChange={(event) => onFormulaChange(event.target.value)}
          onKeyDown={onFormulaKeyDown}
          disabled={isReadOnly}
          aria-label="Cell value or formula"
          className={cn(
            'w-full rounded-md border border-input bg-background px-2 py-1 font-mono text-sm shadow-xs transition-[color,box-shadow] outline-none',
            'focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]',
            isReadOnly && 'cursor-not-allowed opacity-75',
          )}
          placeholder="Enter a value or formula"
        />
        <MentionPickerPortal
          isOpen={mention.isOpen}
          position={mention.position}
          driveId={driveId}
          allowedTypes={['page']}
          initialQuery={mention.query}
          onSelect={mention.onSelect}
          onClose={mention.onClose}
        />
      </div>

      <span className="hidden shrink-0 text-xs text-muted-foreground @[640px]:block">
        {currentDisplay || '—'}
      </span>

      <div className="flex shrink-0 items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          onClick={onAddColumn}
          disabled={isReadOnly}
          className="h-8 px-2"
          aria-label="Add column"
          title="Add column"
        >
          <Columns3 size={16} />
          <span className="hidden @[520px]:inline">Column</span>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={onAddRow}
          disabled={isReadOnly}
          className="h-8 px-2"
          aria-label="Add row"
          title="Add row"
        >
          <Rows3 size={16} />
          <span className="hidden @[520px]:inline">Row</span>
        </Button>
      </div>
    </div>

    {currentError && (
      <p className="pt-1 text-xs text-destructive" role="status">
        {currentError}
      </p>
    )}
  </div>
);
