"use client";

import React from 'react';
import { ClipboardPaste, Copy, Eraser, Hash, Trash2 } from 'lucide-react';
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from '@/components/ui/context-menu';
import type { CopyMode, PasteMode } from '../core/clipboard';

interface SheetContextMenuProps {
  /** Whether a paste is possible (internal copy present or clipboard readable). */
  canPaste: boolean;
  isReadOnly: boolean;
  onCopy: (mode: CopyMode) => void;
  onPaste: (mode: PasteMode) => void;
  onClearContents: () => void;
  onClearFormatting: () => void;
}

/**
 * The grid's right-click menu.
 *
 * This was a hand-rolled `position: fixed` div with `onClick` handlers on
 * non-interactive elements — no roles, no keyboard navigation, no focus
 * management, and a bespoke clamp to keep it on screen. The shared primitive
 * brings all of that, matches `TaskListView`'s item conventions, and lets the
 * clamp and its hook be deleted outright.
 */
export const SheetContextMenu: React.FC<SheetContextMenuProps> = ({
  canPaste,
  isReadOnly,
  onCopy,
  onPaste,
  onClearContents,
  onClearFormatting,
}) => (
  <ContextMenuContent className="w-52">
    <ContextMenuItem onSelect={() => onCopy('formulas')}>
      <Copy className="mr-2 h-4 w-4" />
      Copy
    </ContextMenuItem>
    <ContextMenuItem onSelect={() => onCopy('values')}>
      <Hash className="mr-2 h-4 w-4" />
      Copy values
    </ContextMenuItem>

    <ContextMenuSeparator />

    <ContextMenuItem disabled={!canPaste || isReadOnly} onSelect={() => onPaste('auto')}>
      <ClipboardPaste className="mr-2 h-4 w-4" />
      Paste
    </ContextMenuItem>
    <ContextMenuItem disabled={!canPaste || isReadOnly} onSelect={() => onPaste('values')}>
      <ClipboardPaste className="mr-2 h-4 w-4" />
      Paste values
    </ContextMenuItem>

    <ContextMenuSeparator />

    <ContextMenuItem disabled={isReadOnly} onSelect={onClearFormatting}>
      <Eraser className="mr-2 h-4 w-4" />
      Clear formatting
    </ContextMenuItem>
    <ContextMenuItem
      disabled={isReadOnly}
      onSelect={onClearContents}
      className="text-destructive focus:text-destructive"
    >
      <Trash2 className="mr-2 h-4 w-4" />
      Clear contents
    </ContextMenuItem>
  </ContextMenuContent>
);
