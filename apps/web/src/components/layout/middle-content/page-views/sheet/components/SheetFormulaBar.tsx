import React from 'react';
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
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
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

const UndoIcon = ({ size }: { size: number }) => (
  <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 7v6h6" />
    <path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13" />
  </svg>
);

const RedoIcon = ({ size }: { size: number }) => (
  <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 7v6h-6" />
    <path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13" />
  </svg>
);

/** The responsive formula bar: cell/range info, the mention-aware formula input, undo/redo/add controls, and the error line. */
export const SheetFormulaBar: React.FC<SheetFormulaBarProps> = ({
  isRange,
  selectionAddress,
  currentDisplay,
  currentError,
  isReadOnly,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
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
  <div className="border-b bg-muted/40">
    {/* Cell info row - responsive layout */}
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 pt-2 pb-1 sm:px-4 sm:pt-3">
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-medium uppercase text-muted-foreground sm:text-xs">
          {isRange ? 'Range' : 'Cell'}
        </span>
        <span className="font-semibold text-sm sm:text-base">{selectionAddress}</span>
      </div>
      <div className="hidden text-xs text-muted-foreground sm:block">
        Value: {currentDisplay || '—'}
      </div>
      {/* Mobile action buttons - visible only on small screens */}
      <div className="ml-auto flex items-center gap-1 sm:hidden">
        <Button variant="ghost" size="sm" onClick={onUndo} disabled={isReadOnly || !canUndo} className="h-7 w-7 p-0" aria-label="Undo">
          <UndoIcon size={14} />
        </Button>
        <Button variant="ghost" size="sm" onClick={onRedo} disabled={isReadOnly || !canRedo} className="h-7 w-7 p-0" aria-label="Redo">
          <RedoIcon size={14} />
        </Button>
        <Button variant="ghost" size="sm" onClick={onAddColumn} disabled={isReadOnly} className="h-7 px-2 text-xs" aria-label="Add column">
          +Col
        </Button>
        <Button variant="ghost" size="sm" onClick={onAddRow} disabled={isReadOnly} className="h-7 px-2 text-xs" aria-label="Add row">
          +Row
        </Button>
      </div>
    </div>
    {/* Formula input row */}
    <div className="flex items-center gap-2 px-3 pb-2 sm:gap-3 sm:px-4 sm:pb-3">
      <span className="hidden text-xs font-medium uppercase text-muted-foreground sm:block">Formula</span>
      <div className="relative flex-1">
        <input
          ref={formulaInputRef}
          value={formulaValue}
          onFocus={onFormulaFocus}
          onBlur={onFormulaBlur}
          onChange={(event) => onFormulaChange(event.target.value)}
          onKeyDown={onFormulaKeyDown}
          disabled={isReadOnly}
          className={cn(
            'w-full rounded border border-input bg-background px-2 py-1.5 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20',
            'sm:py-1',
            isReadOnly && 'cursor-not-allowed opacity-75'
          )}
          placeholder="Enter value or formula"
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
      {/* Desktop action buttons */}
      <div className="hidden items-center gap-2 sm:flex">
        <Button variant="ghost" size="sm" onClick={onUndo} disabled={isReadOnly || !canUndo} title="Undo (Ctrl+Z)" className="h-8 w-8 p-0">
          <UndoIcon size={16} />
        </Button>
        <Button variant="ghost" size="sm" onClick={onRedo} disabled={isReadOnly || !canRedo} title="Redo (Ctrl+Shift+Z)" className="h-8 w-8 p-0">
          <RedoIcon size={16} />
        </Button>
        <div className="mx-1 h-4 w-px bg-border" />
        <Button variant="outline" size="sm" onClick={onAddColumn} disabled={isReadOnly}>
          + Column
        </Button>
        <Button variant="outline" size="sm" onClick={onAddRow} disabled={isReadOnly}>
          + Row
        </Button>
      </div>
    </div>
    {currentError && (
      <div className="px-3 pb-2 text-xs text-destructive sm:px-4 sm:pb-3">Error: {currentError}</div>
    )}
  </div>
);
