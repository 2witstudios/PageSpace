import React from 'react';
import { cn } from '@/lib/utils';
import { encodeCellAddress } from '@pagespace/lib/sheets/sheet';
import type { GridSelection } from '../core/selection';
import type { CopyMode } from '../core/clipboard';
import type { MobileActionSheetState } from '../hooks/useSheetTouch';

interface SheetMobileActionSheetProps {
  state: MobileActionSheetState;
  isReadOnly: boolean;
  /** Whether a paste is possible (internal copy present or clipboard readable). */
  canPaste: boolean;
  onEdit: (cell: GridSelection) => void;
  onCopy: (mode: CopyMode) => void;
  onPaste: () => void;
  onClear: (cell: GridSelection) => void;
  onClose: () => void;
}

/** The mobile long-press action sheet (edit / copy / paste / clear). */
export const SheetMobileActionSheet: React.FC<SheetMobileActionSheetProps> = ({
  state,
  isReadOnly,
  canPaste,
  onEdit,
  onCopy,
  onPaste,
  onClear,
  onClose,
}) => {
  if (!state.show) return null;

  const { cell } = state;

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-40 bg-black/50 sm:hidden" onClick={onClose} aria-hidden="true" />
      {/* Action Sheet */}
      <div
        className="fixed inset-x-0 bottom-0 z-50 rounded-t-2xl bg-background p-4 pb-[calc(2rem+env(safe-area-inset-bottom))] shadow-lg sm:hidden"
        role="dialog"
        aria-modal="true"
        aria-label="Cell actions"
      >
        {/* Handle bar */}
        <div className="mx-auto mb-4 h-1 w-12 rounded-full bg-muted-foreground/30" />

        {/* Cell info */}
        <div className="mb-4 text-center">
          <span className="text-sm font-medium text-muted-foreground">
            Cell {cell ? encodeCellAddress(cell.row, cell.column) : ''}
          </span>
        </div>

        {/* Action buttons */}
        <div className="space-y-2">
          <button
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-muted/50 px-4 py-3 text-base font-medium transition-colors active:bg-muted"
            onClick={() => {
              if (cell && !isReadOnly) {
                onEdit(cell);
              }
              onClose();
            }}
            disabled={isReadOnly}
          >
            Edit Cell
          </button>
          <button
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-muted/50 px-4 py-3 text-base font-medium transition-colors active:bg-muted"
            onClick={() => {
              onCopy('formulas');
              onClose();
            }}
          >
            Copy
          </button>
          <button
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-muted/50 px-4 py-3 text-base font-medium transition-colors active:bg-muted"
            onClick={() => {
              onCopy('values');
              onClose();
            }}
          >
            Copy Value
          </button>
          <button
            className={cn(
              'flex w-full items-center justify-center gap-2 rounded-lg bg-muted/50 px-4 py-3 text-base font-medium transition-colors active:bg-muted',
              !canPaste && 'opacity-50'
            )}
            onClick={() => {
              if (canPaste) {
                onPaste();
              }
              onClose();
            }}
            disabled={!canPaste}
          >
            Paste
          </button>
          <button
            className={cn(
              'flex w-full items-center justify-center gap-2 rounded-lg bg-destructive/10 px-4 py-3 text-base font-medium text-destructive transition-colors active:bg-destructive/20',
              isReadOnly && 'opacity-50'
            )}
            onClick={() => {
              if (!isReadOnly && cell) {
                onClear(cell);
              }
              onClose();
            }}
            disabled={isReadOnly}
          >
            Clear Cell
          </button>
        </div>

        {/* Cancel button */}
        <button
          className="mt-4 flex w-full items-center justify-center rounded-lg border border-border px-4 py-3 text-base font-medium transition-colors active:bg-muted"
          onClick={onClose}
        >
          Cancel
        </button>
      </div>
    </>
  );
};
