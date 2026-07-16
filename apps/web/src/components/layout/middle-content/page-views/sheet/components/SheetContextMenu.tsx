import React from 'react';
import { cn } from '@/lib/utils';
import { clampContextMenuPosition } from '../core/layout';
import type { ContextMenuState } from '../hooks/useContextMenu';
import type { CopyMode, PasteMode } from '../core/clipboard';

interface SheetContextMenuProps {
  contextMenu: ContextMenuState;
  /** Whether a paste is possible (internal copy present or clipboard readable). */
  canPaste: boolean;
  onCopy: (mode: CopyMode) => void;
  onPaste: (mode: PasteMode) => void;
  onClose: () => void;
}

/** The desktop right-click context menu (copy/paste), positioned by the pure clamp. */
export const SheetContextMenu: React.FC<SheetContextMenuProps> = ({
  contextMenu,
  canPaste,
  onCopy,
  onPaste,
  onClose,
}) => {
  if (!contextMenu.show) return null;

  const runPaste = (mode: PasteMode) => {
    if (canPaste) {
      onPaste(mode);
      onClose();
    }
  };

  return (
    <div
      className="fixed z-50 bg-background border border-border rounded-md shadow-lg py-1 min-w-[160px]"
      style={clampContextMenuPosition(contextMenu.x, contextMenu.y, contextMenu.bounds, contextMenu.viewport)}
      onClick={(e) => e.stopPropagation()}
    >
      <div
        className="flex items-center px-3 py-2 text-sm cursor-pointer hover:bg-muted transition-colors"
        onClick={() => {
          onCopy('formulas');
          onClose();
        }}
      >
        Copy
      </div>
      <div
        className="flex items-center px-3 py-2 text-sm cursor-pointer hover:bg-muted transition-colors"
        onClick={() => {
          onCopy('values');
          onClose();
        }}
      >
        Copy Values
      </div>
      <div className="h-px bg-border my-1" />
      <div
        className={cn(
          'flex items-center px-3 py-2 text-sm cursor-pointer hover:bg-muted transition-colors',
          !canPaste && 'opacity-50 cursor-not-allowed'
        )}
        onClick={() => runPaste('auto')}
      >
        Paste
      </div>
      <div
        className={cn(
          'flex items-center px-3 py-2 text-sm cursor-pointer hover:bg-muted transition-colors',
          !canPaste && 'opacity-50 cursor-not-allowed'
        )}
        onClick={() => runPaste('values')}
      >
        Paste Values
      </div>
    </div>
  );
};
